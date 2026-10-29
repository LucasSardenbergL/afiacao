-- ============================================================================
-- Trava: SKU ANTIGO de uma consolidação de demanda não volta ao motor
-- [money-path] — incidente: DFA.4128LT (11892839175), consolidado em 12101724100
-- em 05/07/2026 e religado pela UI entre 05/07 e 26/08 → 7 pedidos disparados do
-- SKU antigo (set–out) com parâmetros congelados, enquanto a venda dele TAMBÉM
-- entrava na demanda do destino pela v_venda_items_history_efetivo (dupla conta).
--
-- Invariante: um SKU que é `sku_codigo_antigo` de um mapa ATIVO
-- (status='aplicada' AND acao_parametros='consolidar_demanda') não pode ENTRAR no
-- estado que o motor compra (`habilitado_reposicao_automatica` AND
-- COALESCE(tipo_reposicao,'automatica')='automatica' — o mesmo predicado do
-- WHERE de gerar_pedidos_sugeridos_ciclo). Para religar, desfaça a consolidação.
--
-- Por que no BANCO e não na tela: há ≥2 escritores de reativação (Revisão de
-- Parâmetros "Reativar" e Baixo Giro "Manter em estoque", ambos UPDATE PostgREST
-- direto) e nenhum consulta sku_substituicao; o motor também não.
--
-- Só a TRANSIÇÃO (fora→dentro do motor) é barrada: UPDATE que mantém o estado
-- (recálculo noturno, edição de PP) passa — senão uma linha já contraditória em
-- prod derrubaria o lote inteiro do recálculo.
--
-- SECURITY DEFINER: sku_substituicao tem RLS só para staff; rodando como
-- invoker, um escritor sem papel staff (ou o próprio PostgREST com JWT de outro
-- papel) veria 0 mapas e a trava falharia ABERTA.
--
-- Aplicação: `bun run db:aplicar <este arquivo>` (o executor fornece a
-- transação — sem BEGIN/COMMIT aqui). Prova: db/test-reposicao-trava-reativar-consolidado.sh
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_sku_parametros_trava_reativar_consolidado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_destino text;
BEGIN
  -- Só interessa quem ENTRA no estado que o motor compra.
  IF NOT (COALESCE(NEW.habilitado_reposicao_automatica, false)
          AND COALESCE(NEW.tipo_reposicao, 'automatica') = 'automatica') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.habilitado_reposicao_automatica, false)
     AND COALESCE(OLD.tipo_reposicao, 'automatica') = 'automatica' THEN
    RETURN NEW;   -- já estava no motor: não é reativação
  END IF;

  SELECT s.sku_codigo_novo INTO v_destino
    FROM public.sku_substituicao s
   WHERE upper(s.empresa) = upper(NEW.empresa)
     AND s.sku_codigo_antigo = NEW.sku_codigo_omie::text
     AND s.status = 'aplicada'
     AND s.acao_parametros = 'consolidar_demanda'
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'SKU % teve a demanda consolidada no SKU % — não pode voltar à reposição automática. Desfaça a consolidação antes de reativar.',
      NEW.sku_codigo_omie, v_destino
      USING ERRCODE = 'ZR006';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.trg_sku_parametros_trava_reativar_consolidado() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER sku_parametros_trava_reativar_consolidado
  BEFORE INSERT OR UPDATE OF habilitado_reposicao_automatica, tipo_reposicao ON public.sku_parametros
  FOR EACH ROW EXECUTE FUNCTION public.trg_sku_parametros_trava_reativar_consolidado();

-- Postcondição: trigger ligado, na tabela certa, apontando para a função
-- SECURITY DEFINER, e sem EXECUTE para as roles da API.
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.sku_parametros'::regclass
       AND t.tgname = 'sku_parametros_trava_reativar_consolidado'
       AND t.tgenabled = 'O'
       AND p.proname = 'trg_sku_parametros_trava_reativar_consolidado'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: trava de reativação ausente/desligada/não-definer — o motor volta a comprar SKU consolidado';
  END IF;
  IF has_function_privilege('anon', 'public.trg_sku_parametros_trava_reativar_consolidado()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trg_sku_parametros_trava_reativar_consolidado()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: função da trava executável por anon/authenticated';
  END IF;
END
$post$;
