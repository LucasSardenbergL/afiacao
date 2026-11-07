-- Onda 5A, fatia 1, dos pontos cegos do portal Sayerlack (plano 2026-11-06, itens 5.1 + B + 5.5).
-- Migration MANUAL (custom não auto-aplica no Lovable): aplicar pelo envelope (`bun run db:aplicar`).
--
-- O FURO: o disparador (`disparar-pedidos-aprovados`) aceita pedido `sucesso_portal` com protocolo como
-- `already_sent` e cria o PO no Omie SEM reler o portal. Pedido cancelado na Sayerlack (situação 6) virava
-- compra real assim que a próxima rodada do disparador passasse — e a varredura, que LIA a situação, a jogava
-- fora (`ja_no_app` vence antes de olhar a situação).
--
-- A) 6 colunas de situação no pedido, com UM escritor imposto por trigger + GUC local:
--    · a observação é um INTERVALO [início, fim] da leitura no portal (carimbado pela edge), não o instante de
--      gravar. Leituras concorrentes (Codex v3 P1 #3): só substitui a vigente uma leitura que COMEÇOU depois
--      de a vigente TERMINAR; leitura sobreposta só entra se disser 6 (falha FECHADA: na dúvida, bloqueia);
--    · só código RECONHECIDO (lista fechada 1..7) grava: situação ilegível nunca substitui evidência
--      decisória (Codex 5A rodada 2, P1 #2);
--    · `portal_situacao_protocolo` = o protocolo a que a observação se refere. A ordem temporal vale ENTRE
--      protocolos também: depois de um re-envio, só uma leitura do protocolo atual iniciada depois do fim da
--      observação vigente libera.
-- B) `reposicao_claim_disparo` recusa, NO MESMO WHERE QUE GRAVA, pedido cuja observação aceita é 6 — de
--    QUALQUER protocolo (Codex v3 P1 #4: staff tem UPDATE e trocar `portal_protocolo` não pode liberar
--    compra). Liberar exige observação estritamente posterior (início > fim da vigente) com outro código.
--    Claim existente não é limpo nem expirado.
-- Idempotente; sem DROP. `CREATE OR REPLACE` da claim preserva o ACL (pré-voo: prod = repo 20260906190615,
-- md5(pg_get_functiondef) 2d07026098f94452a3e694f87f6950ef em 2026-11-07).

-- ── A.1 colunas ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS portal_situacao_codigo     text,
  ADD COLUMN IF NOT EXISTS portal_situacao_texto      text,
  ADD COLUMN IF NOT EXISTS portal_situacao_em         timestamptz,
  ADD COLUMN IF NOT EXISTS portal_situacao_ate        timestamptz,
  ADD COLUMN IF NOT EXISTS portal_situacao_protocolo  text,
  ADD COLUMN IF NOT EXISTS portal_situacao_gravada_em timestamptz;

COMMENT ON COLUMN public.pedido_compra_sugerido.portal_situacao_codigo IS
  'Código da situação do pedido no portal Sayerlack (1 Aberto · 2 Atend. Parcial · 3 Atend. Total · 4 Pendentes · 5 Suspenso · 6 Cancelado · 7 Fatur Balcão), última observação ACEITA. Escritor único: sayerlack_registrar_situacao_portal. 6 + protocolo atual bloqueia o claim de disparo.';
COMMENT ON COLUMN public.pedido_compra_sugerido.portal_situacao_em IS
  'INÍCIO da leitura no portal que observou a situação (carimbado pela edge) — não o instante da gravação.';
COMMENT ON COLUMN public.pedido_compra_sugerido.portal_situacao_ate IS
  'FIM da leitura no portal que observou a situação. Só uma leitura iniciada depois disto substitui a observação.';
COMMENT ON COLUMN public.pedido_compra_sugerido.portal_situacao_protocolo IS
  'Protocolo do portal a que a observação se refere; diferente de portal_protocolo ⇒ observação de um protocolo anterior (um 6 dela continua bloqueando o disparo até o protocolo atual ser lido).';

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_compra_sugerido_portal_situacao_check'
                   AND conrelid = 'public.pedido_compra_sugerido'::regclass) THEN
    ALTER TABLE public.pedido_compra_sugerido ADD CONSTRAINT pedido_compra_sugerido_portal_situacao_check CHECK (
      (portal_situacao_codigo IS NULL AND portal_situacao_texto IS NULL AND portal_situacao_em IS NULL
         AND portal_situacao_ate IS NULL AND portal_situacao_protocolo IS NULL AND portal_situacao_gravada_em IS NULL)
      OR (portal_situacao_codigo ~ '^[1-7]$'
         AND portal_situacao_texto IS NOT NULL AND length(portal_situacao_texto) <= 200
         AND portal_situacao_em IS NOT NULL AND portal_situacao_ate IS NOT NULL
         AND portal_situacao_ate >= portal_situacao_em AND portal_situacao_gravada_em IS NOT NULL
         AND portal_situacao_protocolo ~ '^\d{3,12}$')
    );
  END IF;
END
$c$;

-- ── A.2 escritor único: trigger + GUC local ──────────────────────────────────────────────────────
-- Staff (master|employee) tem UPDATE nesta tabela pela RLS: sem isto, qualquer um fabricaria um "6"
-- (bloqueando compra) ou apagaria um (liberando compra de pedido cancelado). O PostgREST não expõe
-- `set_config` ao cliente (vive em pg_catalog) e cada request é uma transação — a GUC local só existe
-- dentro da RPC abaixo.
CREATE OR REPLACE FUNCTION public.sayerlack__situacao_portal_escritor_unico()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF current_setting('app.sayerlack_situacao_portal_escritor', true) IS NOT DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.portal_situacao_codigo IS NULL AND NEW.portal_situacao_texto IS NULL AND NEW.portal_situacao_em IS NULL
       AND NEW.portal_situacao_ate IS NULL
       AND NEW.portal_situacao_protocolo IS NULL AND NEW.portal_situacao_gravada_em IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.portal_situacao_codigo IS NOT DISTINCT FROM OLD.portal_situacao_codigo
     AND NEW.portal_situacao_texto IS NOT DISTINCT FROM OLD.portal_situacao_texto
     AND NEW.portal_situacao_em IS NOT DISTINCT FROM OLD.portal_situacao_em
     AND NEW.portal_situacao_ate IS NOT DISTINCT FROM OLD.portal_situacao_ate
     AND NEW.portal_situacao_protocolo IS NOT DISTINCT FROM OLD.portal_situacao_protocolo
     AND NEW.portal_situacao_gravada_em IS NOT DISTINCT FROM OLD.portal_situacao_gravada_em THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = '[SITUACAO-PORTAL-ESCRITOR-UNICO] a situação do portal só é gravada por sayerlack_registrar_situacao_portal (varredura do portal)';
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack__situacao_portal_escritor_unico() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack__situacao_portal_escritor_unico() FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack__situacao_portal_escritor_unico() FROM authenticated;

DROP TRIGGER IF EXISTS trg_situacao_portal_escritor_unico ON public.pedido_compra_sugerido;
CREATE TRIGGER trg_situacao_portal_escritor_unico
  BEFORE INSERT OR UPDATE OF portal_situacao_codigo, portal_situacao_texto, portal_situacao_em, portal_situacao_ate,
                             portal_situacao_protocolo, portal_situacao_gravada_em
  ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__situacao_portal_escritor_unico();

-- ── A.3 o escritor ───────────────────────────────────────────────────────────────────────────────
-- p_itens: [{protocolo, codigo, texto}]. Item com protocolo ou código fora da gramática é IGNORADO (nunca
-- grava NULL por cima de um 6); protocolo repetido no lote = ambíguo, ignora todos dele. Devolve o que foi
-- ACEITO pelo UPDATE (é isso que vale, não o lote bruto).
CREATE OR REPLACE FUNCTION public.sayerlack_registrar_situacao_portal(p_lido_de timestamptz, p_lido_ate timestamptz, p_itens jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_aceitos    jsonb := '[]'::jsonb;
  v_ignorados  int := 0;
  v_fora_ordem int := 0;
  r            record;
  v_ids        jsonb;
BEGIN
  IF p_lido_de IS NULL OR p_lido_ate IS NULL OR p_lido_ate < p_lido_de
     OR p_lido_ate > now() + interval '2 minutes' OR p_lido_ate - p_lido_de > interval '30 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = '[SITUACAO-PORTAL-INSTANTE] intervalo da leitura inválido: ' || COALESCE(p_lido_de::text, 'NULL')
                || ' → ' || COALESCE(p_lido_ate::text, 'NULL');
  END IF;
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[SITUACAO-PORTAL-ITENS] p_itens tem de ser um array jsonb';
  END IF;

  PERFORM set_config('app.sayerlack_situacao_portal_escritor', 'on', true);

  FOR r IN
    WITH itens AS (
      SELECT btrim(COALESCE(e->>'protocolo', '')) AS protocolo,
             btrim(COALESCE(e->>'codigo', ''))    AS codigo,
             left(btrim(COALESCE(e->>'texto', '')), 200) AS texto
        FROM jsonb_array_elements(p_itens) AS e
    ), contagem AS (
      SELECT protocolo, count(*) AS n FROM itens GROUP BY protocolo
    )
    SELECT i.protocolo, i.codigo, i.texto,
           (i.protocolo ~ '^\d{3,12}$' AND i.codigo ~ '^[1-7]$' AND c.n = 1) AS valido
      FROM itens i JOIN contagem c USING (protocolo)
  LOOP
    IF NOT r.valido THEN
      v_ignorados := v_ignorados + 1;
      CONTINUE;
    END IF;
    WITH up AS (
      UPDATE pedido_compra_sugerido
         SET portal_situacao_codigo     = r.codigo,
             portal_situacao_texto      = CASE WHEN r.texto = '' THEN r.codigo ELSE r.texto END,
             -- 6 sobre 6 do mesmo protocolo: ESTENDE o horizonte do cancelamento (o fim mais tardio), nunca o
             -- encurta — senão uma 3ª leitura sobreposta ao 2º 6 liberaria (Codex 5A v4, P1).
             -- 6 sobre 6 (de QUALQUER protocolo): ESTENDE o horizonte do cancelamento, nunca o encurta — senão uma
             -- leitura sobreposta ao 2º 6 liberaria (Codex 5A v4, P1; rodada 3: idem com troca de protocolo).
             portal_situacao_em         = CASE WHEN r.codigo = '6' AND portal_situacao_codigo = '6'
                                               THEN LEAST(portal_situacao_em, p_lido_de) ELSE p_lido_de END,
             portal_situacao_ate        = CASE WHEN r.codigo = '6' AND portal_situacao_codigo = '6'
                                               THEN GREATEST(portal_situacao_ate, p_lido_ate) ELSE p_lido_ate END,
             portal_situacao_protocolo  = r.protocolo,
             portal_situacao_gravada_em = now()
       WHERE empresa = 'OBEN'
         AND btrim(portal_protocolo) = r.protocolo
         AND (portal_situacao_em IS NULL
              -- leitura que começou DEPOIS de a vigente terminar: estritamente mais nova. É a ÚNICA porta de um
              -- código ≠ 6, inclusive de outro protocolo (Codex 5A rodada 3: trocar o protocolo não fura a ordem).
              OR p_lido_de > portal_situacao_ate
              -- sobreposta (ou posterior) dizendo 6 por cima de não-6: na dúvida, bloqueia
              OR (r.codigo = '6' AND portal_situacao_codigo <> '6' AND p_lido_ate >= portal_situacao_em)
              -- 6 de OUTRO protocolo por cima de não-6, mesmo mais velho: falha fechada
              OR (r.codigo = '6' AND portal_situacao_codigo <> '6' AND portal_situacao_protocolo IS DISTINCT FROM r.protocolo)
              -- outro 6 que termina depois: o cancelamento vale até o fim dele
              OR (r.codigo = '6' AND portal_situacao_codigo = '6' AND p_lido_ate > portal_situacao_ate))
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO v_ids FROM up;
    IF jsonb_array_length(v_ids) > 0 THEN
      v_aceitos := v_aceitos || (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'pedido_id', x, 'protocolo', r.protocolo, 'codigo', r.codigo)), '[]'::jsonb)
                     FROM jsonb_array_elements(v_ids) AS x);
    ELSIF EXISTS (SELECT 1 FROM pedido_compra_sugerido
                   WHERE empresa = 'OBEN' AND btrim(portal_protocolo) = r.protocolo) THEN
      v_fora_ordem := v_fora_ordem + 1;
    END IF;
  END LOOP;

  PERFORM set_config('app.sayerlack_situacao_portal_escritor', '', true);
  RETURN jsonb_build_object('aceitos', v_aceitos, 'ignorados', v_ignorados, 'fora_de_ordem', v_fora_ordem);
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack_registrar_situacao_portal(timestamptz, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_registrar_situacao_portal(timestamptz, timestamptz, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_registrar_situacao_portal(timestamptz, timestamptz, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_registrar_situacao_portal(timestamptz, timestamptz, jsonb) TO service_role;

-- ── B. o claim recusa o cancelado conhecido ──────────────────────────────────────────────────────
-- Corpo de 20260906190615 + UM predicado novo no WHERE que grava (EvalPlanQual: se a observação 6 commitou
-- antes, o claim pega 0 linhas). IS DISTINCT FROM porque `<> '6'` excluiria a linha sem observação (NULL).
CREATE OR REPLACE FUNCTION public.reposicao_claim_disparo(p_pedido_id bigint, p_origem text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_status text;
  v_desde  timestamptz;
  v_atual  text;
  v_cod    text;
  v_sprot  text;
  v_sem    timestamptz;
  v_claim  timestamptz;
BEGIN
  -- ⚠️ O guard e a escrita são UMA instrução. Não separe: o `status IN (…)` e o veto de cancelado no portal
  -- presos a ESTE WHERE são o que faz o Postgres re-avaliá-los contra a linha recém-commitada (EvalPlanQual,
  -- READ COMMITTED). Movê-los para um SELECT acima reabre o Cenário B. `atualizado_em` NÃO é tocado.
  UPDATE pedido_compra_sugerido
     SET disparo_claim_em  = COALESCE(disparo_claim_em, NOW()),
         disparo_claim_por = COALESCE(disparo_claim_por,
                                      left(COALESCE(NULLIF(btrim(p_origem), ''), 'edge'), 120))
   WHERE id = p_pedido_id
     AND status IN ('aprovado_aguardando_disparo', 'falha_envio')
     AND portal_situacao_codigo IS DISTINCT FROM '6'
  RETURNING status, disparo_claim_em INTO v_status, v_desde;

  IF v_status IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', true, 'pedido_id', p_pedido_id,
                              'status', v_status, 'desde', v_desde);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada acima — esta leitura só MONTA A MENSAGEM.
  SELECT status, portal_situacao_codigo, portal_situacao_protocolo, portal_situacao_em, disparo_claim_em
    INTO v_atual, v_cod, v_sprot, v_sem, v_claim
    FROM pedido_compra_sugerido WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'pedido_id', p_pedido_id,
                              'motivo', 'pedido não encontrado');
  END IF;

  IF v_cod = '6' AND v_atual IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    -- `pendente_desde` não nulo = uma tentativa anterior abriu a pendência e não chegou ao desfecho: pode haver
    -- PO no Omie com resposta perdida. A edge concilia SÓ POR CONSULTA (nunca IncluirPedCompra).
    RETURN jsonb_build_object(
      'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
      'bloqueio', 'cancelado_no_portal', 'pendente_desde', v_claim, 'situacao_em', v_sem,
      'motivo', 'pedido cancelado no portal Sayerlack (protocolo ' || COALESCE(v_sprot, '?') ||
                ', lido em ' || COALESCE(to_char(v_sem AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), '?') ||
                '): disparo bloqueado'
    );
  END IF;

  RETURN jsonb_build_object(
    'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
    'motivo', 'pedido não está mais disparável (status atual: '
              || COALESCE(v_atual, '(desconhecido)') || ')'
  );
END;
$$;

-- REPLACE preserva o ACL de prod (só service_role); reemitido mesmo assim — idempotente, e fecha o caso de
-- um banco onde a função nasceu agora com o GRANT padrão do Supabase.
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_claim_disparo(bigint, text) TO service_role;

-- ── Postcondição ─────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src text;
  v_up  text;
  f     text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pedido_compra_sugerido'
         AND column_name IN ('portal_situacao_codigo', 'portal_situacao_texto', 'portal_situacao_em', 'portal_situacao_ate',
                             'portal_situacao_protocolo', 'portal_situacao_gravada_em')) <> 6 THEN
    RAISE EXCEPTION 'S1 FALHOU: as 6 colunas de situação do portal não existem';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_situacao_portal_escritor_unico'
                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'S2 FALHOU: trigger do escritor único ausente ou desligado';
  END IF;
  f := 'public.sayerlack_registrar_situacao_portal(timestamptz, timestamptz, jsonb)';
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'S3 FALHOU: escritor executável por anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'S4 FALHOU: service_role sem EXECUTE no escritor';
  END IF;
  f := 'public.reposicao_claim_disparo(bigint, text)';
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'S5 FALHOU: claim executável por anon/authenticated';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(f);
  v_up := substring(v_src from 'UPDATE\s+pedido_compra_sugerido.*?RETURNING');
  IF v_up IS NULL OR v_up NOT LIKE '%status IN (''aprovado_aguardando_disparo'', ''falha_envio'')%' THEN
    RAISE EXCEPTION 'S6 FALHOU: a allowlist de status do claim não está no WHERE que grava';
  END IF;
  IF v_up NOT LIKE '%AND portal_situacao_codigo IS DISTINCT FROM ''6''%' THEN
    RAISE EXCEPTION 'S7 FALHOU: o veto de cancelado no portal não está no WHERE que grava do claim';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.sayerlack_registrar_situacao_portal(timestamptz, timestamptz, jsonb)');
  IF v_src NOT LIKE '%OR p_lido_de > portal_situacao_ate%' OR v_src NOT LIKE '%GREATEST(portal_situacao_ate, p_lido_ate)%' OR v_src NOT LIKE '%''^[1-7]$''%' THEN
    RAISE EXCEPTION 'S8 FALHOU: o escritor não exige ordem nem código reconhecido';
  END IF;
  RAISE NOTICE 'POSTCONDICAO_OK sayerlack situacao portal no pedido (fatia 1 da onda 5A)';
END
$post$;
