-- ============================================================================
-- Religar um SKU ANTIGO de consolidação de demanda DESCONSOLIDA o mapa
-- [money-path] — incidente: DFA.4128LT (11892839175), consolidado em 12101724100
-- em 05/07/2026 e religado pela UI entre 05/07 e 26/08 → o motor voltou a comprá-lo
-- (7 pedidos disparados, set–out) com parâmetros CONGELADOS (sem linha na view de
-- demanda, o recálculo noturno não o via), enquanto a venda dele TAMBÉM seguia
-- somando no destino pela v_venda_items_history_efetivo (dupla contagem).
--
-- Invariante: nenhum SKU está, ao mesmo tempo, no estado que o motor compra
-- (`habilitado_reposicao_automatica` AND COALESCE(tipo_reposicao,'automatica') =
-- 'automatica' — o WHERE de gerar_pedidos_sugeridos_ciclo) e como
-- `sku_codigo_antigo` de um mapa ATIVO (status='aplicada' AND
-- acao_parametros='consolidar_demanda').
--
-- Decisão do founder (29/10/2026, opção B): SKU antigo que volta a vender é produto
-- VIVO — religá-lo DESFAZ a consolidação (mapa → 'revertida', o status de desfazer
-- já usado pela prova da consolidação): a venda dele sai da demanda do destino e
-- volta ao próprio item, que torna a ser recalculado.
--
-- As DUAS pontas do invariante [Codex P1]:
--   1. sku_parametros (religar): trigger AFTER desfaz o mapa. Há ≥2 escritores de
--      religação (Revisão de Parâmetros "Reativar", Baixo Giro "Manter em estoque",
--      UPDATE PostgREST direto) e nenhum consulta sku_substituicao; o motor também não.
--      Só a TRANSIÇÃO fora→dentro do motor dispara (lote noturno não toca o mapa).
--   2. sku_substituicao (gravar mapa): constraint trigger DEFERRED recusa, no COMMIT,
--      mapa ativo cujo antigo segue no motor. Deferred porque consolidar_demanda_sku
--      grava o mapa ANTES de descontinuar o antigo, na mesma transação.
--
-- Histórico [Codex P2]: UNIQUE (empresa, sku_codigo_antigo, status) impede dois
-- 'revertida' do mesmo antigo; o anterior é RENOMEADO para 'revertida:<id>' (todo
-- leitor filtra status='aplicada'), nunca apagado.
--
-- SECURITY DEFINER: sku_substituicao tem RLS só para staff; rodando como invoker,
-- um escritor sem papel staff veria 0 mapas e o invariante quebraria calado. A
-- postcondição exige dono que de fato fure RLS [Codex P2].
--
-- Aplicação: `bun run db:aplicar <este arquivo>` (o executor fornece a transação —
-- sem BEGIN/COMMIT aqui). Prova: db/test-reposicao-desconsolidar-ao-religar.sh
-- ============================================================================

-- ── 1. religar → desconsolidar ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_sku_parametros_desconsolidar_ao_religar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Só interessa quem ENTRA no estado que o motor compra.
  IF NOT (COALESCE(NEW.habilitado_reposicao_automatica, false)
          AND COALESCE(NEW.tipo_reposicao, 'automatica') = 'automatica') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.habilitado_reposicao_automatica, false)
     AND COALESCE(OLD.tipo_reposicao, 'automatica') = 'automatica' THEN
    RETURN NULL;   -- já estava no motor: não é religação
  END IF;

  -- Abre espaço no UNIQUE preservando o desfazer anterior.
  UPDATE public.sku_substituicao r
     SET status = 'revertida:' || r.id
   WHERE r.status = 'revertida'
     AND EXISTS (SELECT 1 FROM public.sku_substituicao a
                  WHERE a.status = 'aplicada'
                    AND a.acao_parametros = 'consolidar_demanda'
                    AND a.empresa = r.empresa
                    AND a.sku_codigo_antigo = r.sku_codigo_antigo
                    AND upper(a.empresa) = upper(NEW.empresa)
                    AND a.sku_codigo_antigo = NEW.sku_codigo_omie::text);

  UPDATE public.sku_substituicao s
     SET status = 'revertida',
         observacoes = concat_ws(E'\n', NULLIF(s.observacoes, ''),
           format('desconsolidado em %s: SKU religado na reposição automática (%s)',
                  to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI'),
                  COALESCE('usuário ' || auth.uid()::text, 'sem JWT: job ou SQL')))
   WHERE upper(s.empresa) = upper(NEW.empresa)
     AND s.sku_codigo_antigo = NEW.sku_codigo_omie::text
     AND s.status = 'aplicada'
     AND s.acao_parametros = 'consolidar_demanda';
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.trg_sku_parametros_desconsolidar_ao_religar() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER sku_parametros_desconsolidar_ao_religar
  AFTER INSERT OR UPDATE OF habilitado_reposicao_automatica, tipo_reposicao ON public.sku_parametros
  FOR EACH ROW EXECUTE FUNCTION public.trg_sku_parametros_desconsolidar_ao_religar();

-- ── 2. gravar mapa → o antigo tem de estar fora do motor no COMMIT ──────────
CREATE OR REPLACE FUNCTION public.trg_sku_substituicao_exige_antigo_fora_do_motor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Relê o mapa: no COMMIT ele pode já ter sido desfeito na mesma transação.
  IF EXISTS (SELECT 1 FROM public.sku_substituicao s
              WHERE s.id = NEW.id AND s.status = 'aplicada' AND s.acao_parametros = 'consolidar_demanda')
     AND EXISTS (SELECT 1 FROM public.sku_parametros p
                  WHERE upper(p.empresa) = upper(NEW.empresa)
                    AND p.sku_codigo_omie::text = NEW.sku_codigo_antigo
                    AND COALESCE(p.habilitado_reposicao_automatica, false)
                    AND COALESCE(p.tipo_reposicao, 'automatica') = 'automatica') THEN
    RAISE EXCEPTION 'consolidação: o SKU antigo % segue na reposição automática — descontinue-o na mesma transação (consolidar_demanda_sku já faz isso)', NEW.sku_codigo_antigo
      USING ERRCODE = 'ZR006';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.trg_sku_substituicao_exige_antigo_fora_do_motor() FROM PUBLIC, anon, authenticated;

-- Constraint trigger não aceita OR REPLACE: DROP do próprio objeto desta migration + CREATE.
DROP TRIGGER IF EXISTS sku_substituicao_exige_antigo_fora_do_motor ON public.sku_substituicao;
CREATE CONSTRAINT TRIGGER sku_substituicao_exige_antigo_fora_do_motor
  AFTER INSERT OR UPDATE ON public.sku_substituicao
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_sku_substituicao_exige_antigo_fora_do_motor();

-- ── 3. restaura o invariante nas linhas que JÁ o violam ─────────────────────
-- 29/10/2026: só 11892839175 → 12101724100. Idempotente: re-rodar não acha mais nada.
CREATE TEMP TABLE _viol ON COMMIT DROP AS
SELECT s.id, s.empresa, s.sku_codigo_antigo
  FROM public.sku_substituicao s
  JOIN public.sku_parametros p
    ON upper(p.empresa) = upper(s.empresa) AND p.sku_codigo_omie::text = s.sku_codigo_antigo
 WHERE s.status = 'aplicada' AND s.acao_parametros = 'consolidar_demanda'
   AND COALESCE(p.habilitado_reposicao_automatica, false)
   AND COALESCE(p.tipo_reposicao, 'automatica') = 'automatica';

UPDATE public.sku_substituicao r
   SET status = 'revertida:' || r.id
  FROM _viol v
 WHERE r.status = 'revertida' AND r.empresa = v.empresa AND r.sku_codigo_antigo = v.sku_codigo_antigo;

UPDATE public.sku_substituicao s
   SET status = 'revertida',
       observacoes = concat_ws(E'\n', NULLIF(s.observacoes, ''),
         'desconsolidado em 2026-10-29: SKU religado na reposição automática antes da trava (decisão do founder, opção B)')
  FROM _viol v
 WHERE s.id = v.id;

-- ── postcondição ────────────────────────────────────────────────────────────
DO $post$
DECLARE v_viol int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_roles o ON o.oid = p.proowner
     WHERE t.tgrelid = 'public.sku_parametros'::regclass
       AND t.tgname = 'sku_parametros_desconsolidar_ao_religar'
       AND t.tgenabled = 'O'
       AND p.proname = 'trg_sku_parametros_desconsolidar_ao_religar'
       AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: trigger de desconsolidação ausente/desligado/não-definer/dono sujeito a RLS — religar um antigo volta a contar a demanda em dobro';
  END IF;
  IF has_function_privilege('anon', 'public.trg_sku_parametros_desconsolidar_ao_religar()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trg_sku_parametros_desconsolidar_ao_religar()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trg_sku_substituicao_exige_antigo_fora_do_motor()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trg_sku_substituicao_exige_antigo_fora_do_motor()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: função de trigger executável por anon/authenticated';
  END IF;
  SELECT count(*) INTO v_viol
    FROM public.sku_substituicao s
    JOIN public.sku_parametros p
      ON upper(p.empresa) = upper(s.empresa) AND p.sku_codigo_omie::text = s.sku_codigo_antigo
   WHERE s.status = 'aplicada' AND s.acao_parametros = 'consolidar_demanda'
     AND COALESCE(p.habilitado_reposicao_automatica, false)
     AND COALESCE(p.tipo_reposicao, 'automatica') = 'automatica';
  IF v_viol > 0 THEN
    RAISE EXCEPTION 'A3 FALHOU: % SKU(s) antigo(s) de mapa ativo seguem no motor — compra do antigo + demanda dele no destino', v_viol;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_roles o ON o.oid = p.proowner
     WHERE t.tgrelid = 'public.sku_substituicao'::regclass
       AND t.tgname = 'sku_substituicao_exige_antigo_fora_do_motor'
       AND t.tgenabled = 'O' AND t.tgdeferrable AND t.tginitdeferred
       AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'A4 FALHOU: guarda deferred de sku_substituicao ausente/imediata/não-definer — mapa novo sobre SKU no motor passaria';
  END IF;
END
$post$;
