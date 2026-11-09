-- ============================================================
-- Radar: o evento 'abriu' passa a dizer QUAL ficha foi aberta (cnpj do lead em radar_eventos)
--
-- POR QUÊ: em 2026-11-06 (psql-ro) havia 4 'abriu' humanos em 30 dias e 0 com cnpj. Causa na ORIGEM: o 'abriu'
-- nasce de 'navegacao.rota_servida' com rota '/radar' (a TELA servida, 1 por titular e dia, sem CNPJ); abrir a
-- ficha (RadarDetailSheet) não emitia nada ao ledger. Não era o outbox nem a cópia que perdiam o CNPJ — ele
-- nunca existiu. Sem isto não dá para medir quais fichas são abertas, nem as que têm selo de vínculo/sucessor.
--
-- O QUE MUDA (sensor novo NÃO: o mesmo 'abriu', mais uma fonte):
--   1. analytics_ledger_registrar: a allowlist ganha 'radar.ficha_aberta' (chave = CNPJ → 1 por titular, CNPJ e
--      dia; props {cnpj}). Corpo = o da 20261103120100 (md5 45d77112752d3d4470e620fa361b3119, = PROD); muda SÓ a allowlist.
--      O teste de paridade src/lib/__tests__/analytics-ledger-paridade.test.ts lê ESTE arquivo.
--   2. private.radar_evento_abertura + trg_radar_evento_abertura: a ficha vira 'abriu' COM cnpj; a tela segue
--      'abriu' com cnpj NULL. Ficha sem CNPJ válido não grava (WARNING) — nunca cnpj fabricado.
--   3. radar_placar_uso: 'aberturas' segue contando só a TELA (cnpj IS NULL) — sem isto cada ficha inflaria
--      o número; 'abriram' (titulares distintos) conta as duas; a reconciliação do fail-open cobre as duas.
-- A lente "Ver como" fica fora na FONTE: registrarNoLedger retorna cedo sob isLensActive().
--
-- Corpos vivos lidos da PROD em 2026-11-06 (psql-ro): ledger 45d77112752d3d4470e620fa361b3119, abertura 988d0f20664dabcc5a72216c99bb0a59,
-- placar a56f4869ef9b276d8678d97fe824b7e9 — iguais aos do repo. Molde TRAVA → PRE → CREATE → PÓS.
-- Prova PG17: db/test-radar-placar.sh (fase B) e --falsificar.
--
-- Aplicação: `bun run db:aplicar supabase/migrations/20261106132259_radar_abriu_ficha_com_cnpj.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (mesma volatilidade VIVA) prende cada função até o fim.
DO $trava$
BEGIN
  ALTER FUNCTION public.analytics_ledger_registrar(text, text, jsonb) VOLATILE;
  ALTER FUNCTION private.radar_evento_abertura() VOLATILE;
  ALTER FUNCTION public.radar_placar_uso() STABLE;
END
$trava$;

-- PRE: md5 EXATO de cada corpo vivo ∈ {predecessor, este}; o trigger vivo é o antigo ou este. Ausente ABORTA.
DO $pre$
DECLARE
  v_led text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'));
  v_ab  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_evento_abertura()'));
  v_pl  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_placar_uso()'));
  v_trg text := (SELECT pg_get_triggerdef(t.oid) FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.analytics_outbox'::regclass AND t.tgname = 'trg_radar_evento_abertura');
BEGIN
  IF v_led IS NULL OR v_led NOT IN ('45d77112752d3d4470e620fa361b3119', '7dc8856407bf4379b4e34556f42ba748') THEN
    RAISE EXCEPTION 'PRE FALHOU: analytics_ledger_registrar vivo (md5 %) não é o predecessor nem este — outra sessão mexeu na allowlist; reconcilie antes', v_led;
  END IF;
  IF v_ab IS NULL OR v_ab NOT IN ('988d0f20664dabcc5a72216c99bb0a59', '8814af267c3c98e635ded151ca895c6c') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_evento_abertura vivo (md5 %) não é o predecessor nem este', v_ab;
  END IF;
  IF v_pl IS NULL OR v_pl NOT IN ('a56f4869ef9b276d8678d97fe824b7e9', 'f648bcff995f7b4db87b2bd829831cbc') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_placar_uso vivo (md5 %) não é o predecessor nem este', v_pl;
  END IF;
  IF v_trg IS NULL OR (v_trg <> 'CREATE TRIGGER trg_radar_evento_abertura AFTER INSERT ON public.analytics_outbox FOR EACH ROW WHEN (((new.evento = ''navegacao.rota_servida''::text) AND ((new.props ->> ''rota''::text) = ''/radar''::text))) EXECUTE FUNCTION private.radar_evento_abertura()' AND position('radar.ficha_aberta' in v_trg) = 0) THEN
    RAISE EXCEPTION 'PRE FALHOU: trg_radar_evento_abertura vivo não é o antigo nem este: %', v_trg;
  END IF;
END
$pre$;

-- 1. Ledger. Corpo = o da 20261103120100; muda SÓ a allowlist.
CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(
  p_evento text,
  p_chave  text,
  p_props  jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_dia  text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
  -- SECURITY DEFINER bypassa RLS ⇒ o gate vive AQUI, na fronteira.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: exige usuario autenticado'
      USING ERRCODE = '28000';
  END IF;

  -- Allowlist FECHADA: o ledger não é canal genérico de escrita no banco.
  IF p_evento NOT IN ('carteira.mixgap_servido', 'navegacao.rota_servida', 'dashboard.crescimento_comparavel_servido',
                      'venda.ficha_aberta', 'venda.contato_registrado', 'venda.tel_clicado', 'venda.painel_aberto',
                      'financeiro.ciclo_aberto', 'reposicao.corantes_aberta', 'reposicao.raio_x_aberta',
                      'reposicao.raio_x_decisao', 'radar.ficha_aberta') THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: evento % fora da allowlist', p_evento
      USING ERRCODE = '22023';
  END IF;

  IF pg_column_size(coalesce(p_props, '{}'::jsonb)) > 2048 THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: props acima do teto'
      USING ERRCODE = '22023';
  END IF;

  -- Teto por titular/dia — guard contra flood por chave variada. Silencioso de
  -- propósito: telemetria nunca quebra a tela de quem está trabalhando.
  IF (
    SELECT count(*) FROM public.analytics_outbox
    WHERE user_id = v_uid AND ocorrido_em > now() - interval '1 day'
  ) >= 500 THEN
    RETURN;
  END IF;

  INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
  VALUES (
    p_evento,
    v_uid::text,                       -- casa com identify(userId) do front
    v_uid,
    coalesce(p_props, '{}'::jsonb),
    -- left() protege o teto do CHECK e do índice B-tree; o dia fecha a janela
    -- de dedup (mesmo estado revisto amanhã é sinal NOVO, não repetição).
    'ledger:' || v_uid::text || ':' || p_evento || ':' || left(coalesce(p_chave, ''), 100) || ':' || v_dia
  )
  ON CONFLICT (chave_dedup) DO NOTHING;
END;
$fn$;

-- ⚠️ CLAUDE.md: revogar NOMEANDO as roles — FROM PUBLIC não tira anon. Reemitir é idempotente.
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

-- 2. Abertura: a ficha carrega o CNPJ. Corpo = o da 20261029150100 + a 2ª fonte.
CREATE OR REPLACE FUNCTION private.radar_evento_abertura()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cnpj text;
BEGIN
  BEGIN
    -- Captura mínima: titular, instante e id do outbox. Sem titular não há "humano" a contar.
    -- Duas fontes, um evento: a TELA servida ('navegacao.rota_servida' /radar) grava cnpj NULL; a FICHA
    -- aberta ('radar.ficha_aberta') grava o CNPJ do lead — é ele que diz QUAL ficha foi aberta.
    IF NEW.user_id IS NOT NULL THEN
      IF NEW.evento = 'radar.ficha_aberta' THEN
        v_cnpj := NEW.props ->> 'cnpj';
        -- Ficha sem CNPJ válido não vira 'abriu' (seria contada como tela): fica visível na reconciliação
        -- do placar (aberturas_outbox_sem_evento), nunca gravada com cnpj fabricado.
        IF v_cnpj IS NULL OR v_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
          RAISE WARNING 'radar_eventos: ficha % sem CNPJ válido, abertura não registrada', NEW.event_id;
          RETURN NEW;
        END IF;
      END IF;
      INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, fonte_id)
      VALUES ('abriu', 'humano', NEW.ocorrido_em, NEW.user_id, v_cnpj, 'outbox:' || NEW.event_id)
      ON CONFLICT (fonte_id) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'radar_eventos: abertura % não registrada (%: %)', NEW.event_id, SQLSTATE, left(SQLERRM, 120);
  END;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION private.radar_evento_abertura() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_radar_evento_abertura
  AFTER INSERT ON public.analytics_outbox
  FOR EACH ROW WHEN ((NEW.evento = 'navegacao.rota_servida' AND NEW.props ->> 'rota' = '/radar')
                     OR NEW.evento = 'radar.ficha_aberta')
  EXECUTE FUNCTION private.radar_evento_abertura();

COMMENT ON COLUMN public.radar_eventos.cnpj IS
  'CNPJ do lead. Em ''abriu'': NULL = a TELA /radar servida (1 por titular e dia); preenchido = a FICHA desse CNPJ aberta (1 por titular, CNPJ e dia).';

-- 3. Placar: 'aberturas' = só a tela (cnpj NULL); reconciliação cobre tela e ficha. RETURNS TABLE igual (REPLACE preserva o ACL).
CREATE OR REPLACE FUNCTION public.radar_placar_uso()
 RETURNS TABLE (
   janela text, desde timestamptz,
   autorizados_agora integer, autorizados_motivo text,
   abriram integer, aberturas integer,
   tocaram integer, toques integer, em_conversa integer, descartes integer, devolvidos integer, desfeitos integer,
   cadastraram integer, cadastros_novos integer, vinculos_existentes integer,
   eventos_automaticos integer,
   contatos_sem_evento integer, apagados_sem_desfeito integer, cadastros_sem_evento integer,
   aberturas_outbox_sem_evento integer,
   aberturas_cobertas_desde timestamptz, aberturas_janela_completa boolean)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_aut      integer;
  v_motivo   text;
  v_sem_ct   integer;
  v_apagados integer;
  v_sem_ab   integer;
  v_sem_cad  integer;
  v_ab_desde timestamptz;
BEGIN
  -- Autorizados AGORA = capability da frente 2, resolvida TARDE: ausente ⇒ NULL com motivo, nunca 0.
  -- Não reconstrói autorização histórica: é o mesmo número em todas as janelas.
  IF to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL THEN
    v_motivo := 'private.cap_radar_prospectar(uuid) ausente';
  ELSE
    EXECUTE 'SELECT count(DISTINCT ur.user_id)::integer FROM public.user_roles ur WHERE private.cap_radar_prospectar(ur.user_id)'
      INTO v_aut;
  END IF;

  -- Reconciliação do fail-open.
  SELECT count(*)::integer INTO v_sem_ct
    FROM public.radar_contatos c
   WHERE NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'contato:' || c.id);
  SELECT count(*)::integer INTO v_apagados
    FROM public.radar_eventos e
   WHERE e.evento = 'contato'
     AND NOT EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = e.contato_id)
     AND NOT EXISTS (SELECT 1 FROM public.radar_eventos d WHERE d.fonte_id = 'desfeito:' || e.contato_id);
  SELECT count(*)::integer INTO v_sem_cad
    FROM public.radar_empresas re
   WHERE re.omie_cadastrado_em IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'cadastro:' || re.cnpj);
  SELECT count(*)::integer INTO v_sem_ab
    FROM public.analytics_outbox o
   WHERE ((o.evento = 'navegacao.rota_servida' AND o.props ->> 'rota' = '/radar') OR o.evento = 'radar.ficha_aberta')
     AND o.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.radar_eventos e WHERE e.fonte_id = 'outbox:' || o.event_id);
  -- Cobertura de aberturas = nascimento do ledger (o backfill grava todos os contatos existentes no apply), ou
  -- antes, se o outbox ainda retinha abertura então. Janela que começa antes disso é PARCIAL: o "0" dela é
  -- ausência de dado, não falta de uso (Codex de código, P2 — min(abriu) era a 1ª abertura, não a cobertura).
  SELECT least(min(e.gravado_em), min(e.ocorrido_em) FILTER (WHERE e.evento = 'abriu'))
    INTO v_ab_desde FROM public.radar_eventos e;

  RETURN QUERY
  WITH j(janela, desde, ordem) AS (VALUES
         ('7d',    now() - interval '7 days',  1),
         ('30d',   now() - interval '30 days', 2),
         ('60d',   now() - interval '60 days', 3),
         ('total', '-infinity'::timestamptz,   4)),
       ev AS (
         SELECT e.*,
                (e.evento = 'contato' AND EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = e.contato_id)) AS valido
           FROM public.radar_eventos e)
  SELECT j.janela, j.desde, v_aut, v_motivo,
         (count(DISTINCT ev.user_id) FILTER (WHERE ev.evento = 'abriu' AND ev.origem = 'humano'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'abriu' AND ev.origem = 'humano' AND ev.cnpj IS NULL))::integer,
         (count(DISTINCT ev.user_id) FILTER (WHERE ev.valido AND ev.origem = 'humano'
                                              AND ev.acao IN ('contatado_sem_resposta', 'em_conversa')))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao IN ('contatado_sem_resposta', 'em_conversa')))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao = 'em_conversa'))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao = 'descartado'))::integer,
         (count(*) FILTER (WHERE ev.valido AND ev.origem = 'humano' AND ev.acao = 'a_contatar'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'contato_desfeito' AND ev.origem = 'humano'))::integer,
         (count(DISTINCT ev.user_id) FILTER (WHERE ev.evento = 'cadastrou' AND ev.origem = 'humano'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'cadastrou' AND ev.origem = 'humano' AND ev.acao = 'incluir'))::integer,
         (count(*) FILTER (WHERE ev.evento = 'cadastrou' AND ev.origem = 'humano' AND ev.acao = 'lookup'))::integer,
         (count(*) FILTER (WHERE ev.origem = 'automatica'))::integer,
         v_sem_ct, v_apagados, v_sem_cad, v_sem_ab, v_ab_desde, (j.desde >= v_ab_desde)
    FROM j
    LEFT JOIN ev ON ev.ocorrido_em >= j.desde
   GROUP BY j.janela, j.desde, j.ordem
   ORDER BY j.ordem;
END
$function$;

REVOKE ALL ON FUNCTION public.radar_placar_uso() FROM PUBLIC, anon, authenticated;

DO $post$
DECLARE
  v_led oid := to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')::oid;
  v_ab  oid := to_regprocedure('private.radar_evento_abertura()')::oid;
  v_pl  oid := to_regprocedure('public.radar_placar_uso()')::oid;
  v_def text;
  v_ev  text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_led) IS DISTINCT FROM '7dc8856407bf4379b4e34556f42ba748' THEN
    RAISE EXCEPTION 'P1 FALHOU: corpo vivo do ledger não é o desta migration';
  END IF;
  v_def := pg_get_functiondef(v_led);
  FOREACH v_ev IN ARRAY ARRAY['carteira.mixgap_servido', 'navegacao.rota_servida', 'dashboard.crescimento_comparavel_servido',
                              'venda.ficha_aberta', 'venda.contato_registrado', 'venda.tel_clicado', 'venda.painel_aberto',
                              'financeiro.ciclo_aberto', 'reposicao.corantes_aberta', 'reposicao.raio_x_aberta',
                              'reposicao.raio_x_decisao', 'radar.ficha_aberta'] LOOP
    IF position(v_ev in v_def) = 0 THEN
      RAISE EXCEPTION 'P2 FALHOU: allowlist sem %', v_ev;
    END IF;
  END LOOP;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_ab) IS DISTINCT FROM '8814af267c3c98e635ded151ca895c6c' THEN
    RAISE EXCEPTION 'P3 FALHOU: corpo vivo de radar_evento_abertura não é o desta migration';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_pl) IS DISTINCT FROM 'f648bcff995f7b4db87b2bd829831cbc' THEN
    RAISE EXCEPTION 'P4 FALHOU: corpo vivo de radar_placar_uso não é o desta migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.analytics_outbox'::regclass AND t.tgname = 'trg_radar_evento_abertura'
                    AND t.tgenabled = 'O' AND t.tgfoid = v_ab
                    AND position('radar.ficha_aberta' in pg_get_triggerdef(t.oid)) > 0
                    AND position('navegacao.rota_servida' in pg_get_triggerdef(t.oid)) > 0) THEN
    RAISE EXCEPTION 'P5 FALHOU: trg_radar_evento_abertura não escuta tela E ficha (ou está desligado)';
  END IF;
  IF has_function_privilege('anon', v_led, 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: anon executa o ledger';
  END IF;
  IF has_function_privilege('anon', v_pl, 'EXECUTE') OR has_function_privilege('authenticated', v_pl, 'EXECUTE') THEN
    RAISE EXCEPTION 'P7 FALHOU: API executa radar_placar_uso';
  END IF;
END
$post$;
