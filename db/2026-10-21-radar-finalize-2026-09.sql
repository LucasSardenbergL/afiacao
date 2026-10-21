-- Recuperação do lote 2026-09 do Radar: o `finalize` da edge `radar-ingest` caiu em 57014
-- (statement timeout de 8s do PostgREST/authenticator) dentro de `radar_aplicar_situacao`, cujo
-- passo (a) atualiza ~553k linhas de radar_empresas na 1ª foto RFB. Tudo voltou (transação única):
-- zero lead descartado, zero alerta, rfb_situacao vazio, lote em 'error'.
--
-- Este arquivo refaz o `finalize` da edge, NA MESMA ORDEM e com as MESMAS contagens
-- (supabase/functions/radar-ingest/index.ts, action "finalize"): recruzar → aplicar_situacao →
-- total/novos → status 'complete'. Roda por `bun run db:aplicar` (statement_timeout 300s, transação
-- do executor). Idempotente pela guarda: só age com o lote em 'error'; re-rodar depois aborta no PRE.
-- Os chunks já gravaram tudo (502.779 empresas com ultimo_lote=2026-09, 565.696 linhas de situação).

DO $rec$
DECLARE
  v_estado   text;
  v_ini      timestamptz;
  v_sit_n    bigint;
  v_rec      integer;
  v_sit      jsonb;
  v_total    bigint;
  v_novos    bigint;
  v_upd      integer;
BEGIN
  SELECT status, iniciado_em INTO v_estado, v_ini
    FROM public.radar_ingest_state WHERE mes_referencia = '2026-09' FOR UPDATE;
  IF v_estado IS DISTINCT FROM 'error' THEN
    RAISE EXCEPTION 'PRE: lote 2026-09 em %, não em error — nada a recuperar', COALESCE(v_estado, '(ausente)');
  END IF;
  IF EXISTS (SELECT 1 FROM public.radar_ingest_state WHERE status = 'running') THEN
    RAISE EXCEPTION 'PRE: há lote running — outra carga em andamento';
  END IF;
  SELECT count(*) INTO v_sit_n FROM public.radar_situacao_cadastral WHERE lote = '2026-09';
  IF v_sit_n < 500000 THEN
    RAISE EXCEPTION 'PRE: só % linhas de situação no lote 2026-09 (esperado ~565.696)', v_sit_n;
  END IF;

  v_rec := public.radar_recruzar_ja_cliente();
  v_sit := public.radar_aplicar_situacao('2026-09');

  SELECT count(*) INTO v_total FROM public.radar_empresas WHERE ultimo_lote = '2026-09';
  SELECT count(*) INTO v_novos FROM public.radar_empresas
   WHERE ultimo_lote = '2026-09' AND primeira_vista_em >= v_ini;

  UPDATE public.radar_ingest_state
     SET status = 'complete', total_recebido = v_total, novos = v_novos,
         finalizado_em = now(), erro = NULL
   WHERE mes_referencia = '2026-09' AND status = 'error';
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd <> 1 THEN
    RAISE EXCEPTION 'radar_ingest_state marcou % linhas (esperado 1)', v_upd;
  END IF;

  RAISE NOTICE 'RECUPERACAO_2026_09 %', jsonb_build_object(
    'recruzar', v_rec, 'situacao', v_sit, 'total', v_total, 'novos', v_novos);
END $rec$;

DO $post$
DECLARE
  v_st        record;
  v_sem_foto  bigint;
  v_leads     bigint;
  v_cli_sem   bigint;
  v_alerta    bigint;
BEGIN
  SELECT status, total_recebido, novos, finalizado_em INTO v_st
    FROM public.radar_ingest_state WHERE mes_referencia = '2026-09';
  IF v_st.status <> 'complete' OR v_st.total_recebido < 500000 OR v_st.novos IS NULL OR v_st.finalizado_em IS NULL THEN
    RAISE EXCEPTION 'POST: estado do lote 2026-09 inesperado: %', row_to_json(v_st);
  END IF;

  -- (a) toda empresa do radar com linha de situação no lote ficou com a foto 2026-09
  SELECT count(*) INTO v_sem_foto
    FROM public.radar_situacao_cadastral s JOIN public.radar_empresas re ON re.cnpj = s.cnpj
   WHERE s.lote = '2026-09'
     AND (re.rfb_situacao_lote IS DISTINCT FROM '2026-09' OR re.rfb_situacao IS DISTINCT FROM s.situacao);
  IF v_sem_foto <> 0 THEN
    RAISE EXCEPTION 'POST: % empresas sem a foto RFB 2026-09', v_sem_foto;
  END IF;

  -- (b) nenhum lead (não-cliente) irregular segue na fila
  WITH c AS MATERIALIZED (SELECT doc FROM public.radar_docs_clientes())
  SELECT count(*) INTO v_leads
    FROM public.radar_situacao_cadastral s JOIN public.radar_empresas re ON re.cnpj = s.cnpj
   WHERE s.lote = '2026-09' AND s.situacao IN ('03','04','08')
     AND NOT re.ja_cliente AND NOT EXISTS (SELECT 1 FROM c WHERE c.doc = s.cnpj)
     AND re.prospeccao_status NOT IN ('descartado', 'virou_cliente');
  IF v_leads <> 0 THEN
    RAISE EXCEPTION 'POST: % leads irregulares seguem na fila', v_leads;
  END IF;

  -- (c) todo cliente irregular do lote tem o par (cnpj, situacao) alertado em algum lote
  WITH c AS MATERIALIZED (SELECT doc FROM public.radar_docs_clientes())
  SELECT count(*) INTO v_cli_sem
    FROM public.radar_situacao_cadastral s
    LEFT JOIN public.radar_empresas re ON re.cnpj = s.cnpj
   WHERE s.lote = '2026-09' AND s.situacao IN ('03','04','08')
     AND (COALESCE(re.ja_cliente, false) OR EXISTS (SELECT 1 FROM c WHERE c.doc = s.cnpj))
     AND NOT EXISTS (SELECT 1 FROM public.radar_situacao_cadastral a
                      WHERE a.cnpj = s.cnpj AND a.situacao = s.situacao AND a.alertado_em IS NOT NULL);
  IF v_cli_sem <> 0 THEN
    RAISE EXCEPTION 'POST: % clientes irregulares sem alerta', v_cli_sem;
  END IF;

  SELECT count(*) INTO v_alerta FROM public.fornecedor_alerta
   WHERE titulo LIKE '[Radar] % cliente(s) com baixa/inaptidão no lote 2026-09';
  IF v_alerta > 1 THEN
    RAISE EXCEPTION 'POST: % alertas de clientes para o lote 2026-09 (esperado ≤ 1)', v_alerta;
  END IF;
  RAISE NOTICE 'POST_OK alerta_clientes=%', v_alerta;
END $post$;
