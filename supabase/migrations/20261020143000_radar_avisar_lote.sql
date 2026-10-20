-- =============================================================================
-- Radar: AVISO AO GESTOR por lote mensal fechado — um e-mail com denominador, nunca repetido
-- =============================================================================
-- Problema: a carga mensal fecha o lote (radar_ingest_state.status='complete') em silêncio. O gestor
-- só descobre que há 27.466 inéditos (lote 2026-08) abrindo a tela. Regra da casa
-- (docs/historico/fase-sem-sinal.md): aviso SEMPRE com denominador; "quando medir" é query.
--
-- O que entra (idempotente; envelope BEGIN/COMMIT para SQL Editor/MCP; postcondição DO $post$):
--   1. `radar_ingest_state.avisado_em` — dedupe do aviso (coluna dedicada). Escritor: radar_avisar_lote().
--      BOOTSTRAP único, amarrado à CRIAÇÃO da coluna (DO $boot$): lotes fechados ANTES do aviso existir
--      não ganham e-mail retroativo, exceto o mais recente (2026-05 marcado · 2026-08 ganha o 1º real).
--      Re-colar a migration depois NÃO toca a coluna — um lote legitimamente pendente nunca é apagado
--      (Codex P1 #1).
--   2. `radar_avisar_lote(p_agora)` — SECURITY DEFINER, entrypoint de JOB. Para cada lote complete com
--      avisado_em IS NULL e finalizado_em há ≥ 15 min (`c_espera`: dá tempo ao finalize/recruzar):
--        • inéditos N de T — N é o `novos` PERSISTIDO no finalize (mesma definição: primeira_vista_em ≥
--          iniciado_em ∧ ultimo_lote = lote); sem ele, contagem pela JANELA do lote (primeira_vista_em entre
--          o iniciado_em deste e o do lote seguinte), que não depende de `ultimo_lote` ser sobrescrito por
--          carga posterior (Codex P1 #2). T = total_recebido.
--        • saíram do dump S de T_anterior — S = vigentes EXATAMENTE no lote anterior (ultimo_lote = lote_ant,
--          não descartado/virou_cliente), não o acumulado de todos os meses (Codex P1 #3); T_anterior =
--          total_recebido do lote complete anterior; sem lote anterior → "sem lote anterior", nunca "de 0".
--        • baixas de clientes K de M verificados — foto RFB do lote × clientes (ja_cliente ∪
--          radar_docs_clientes(), CTE MATERIALIZED do universo pequeno); M = 0 → "nenhum cliente com
--          situação verificada", nunca "0 de 0".
--        • score: só quando a ÚLTIMA rodada automática do score (ledger radar.score_recalcular, sucesso)
--          registrou `lote_vigente` = este lote — a foto que o score avaliou é a deste aviso (Codex P1 #4).
--          Rodada anterior/ausente → "score pendente"; rodada já de lote posterior → "indisponível"; nunca
--          "0 de N" fabricado (ausente ≠ zero). Com score: P de N inéditos ≥ 70 + top 10 (razão social,
--          município/UF, score, 2 motivos).
--      Insere 1 linha em fornecedor_alerta (empresa 'oben', tipo 'outro', severidade 'info', status
--      'pendente_notificacao' → dispatch-notifications envia o e-mail; mesmo canal do #3212), grava
--      avisado_em e, ao final, 1 linha em acoes_execucoes (slug radar.avisar_lote, origem automatica) quando
--      ≥ 1 lote foi avisado (dia sem lote novo não suja o ledger; job_run_details é a fonte do "rodou").
--      Erro PROPAGA — nada é engolido; tudo numa transação (alerta + avisado_em + ledger ou nada).
--      `FOR UPDATE SKIP LOCKED` no lote: duas execuções concorrentes nunca avisam o mesmo lote.
--   3. cron `radar-avisar-lote-diario` 06:45 UTC (03:45 BRT; cron.timezone vazio = UTC, sync.md), job
--      PRÓPRIO — mesmo molde dos vizinhos (213 recruzar 06:15 · 225 score 06:30 · este 06:45): 1 job =
--      1 função = 1 linha em job_run_details; encadear no comando do 213 amarraria o aviso ao sucesso do
--      recruzamento. Lote fechado segunda ~09:00 UTC é avisado terça 06:45 (depois do score das 06:30).
--
-- Ordem de apply: depois de 20261019200000 (radar_situacao_cadastral, radar_docs_clientes) e
-- 20261019180000 (score, ledger com lote_vigente). Prova PG17: db/test-radar-avisar-lote.sh (--falsificar).
-- =============================================================================

BEGIN;

-- Bootstrap ÚNICO: coluna + backfill só na criação. Re-apply não entra aqui (pendência legítima preservada).
DO $boot$
DECLARE
  v_pend integer;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'radar_ingest_state' AND column_name = 'avisado_em') THEN
    RAISE NOTICE 'radar_ingest_state.avisado_em já existe — bootstrap pulado (pendências preservadas)';
    RETURN;
  END IF;
  ALTER TABLE public.radar_ingest_state ADD COLUMN avisado_em timestamptz;
  UPDATE public.radar_ingest_state
     SET avisado_em = finalizado_em
   WHERE status = 'complete'
     AND avisado_em IS NULL
     AND mes_referencia < (SELECT max(mes_referencia) FROM public.radar_ingest_state WHERE status = 'complete');
  SELECT count(*) INTO v_pend FROM public.radar_ingest_state
   WHERE status = 'complete' AND avisado_em IS NULL
     AND mes_referencia < (SELECT max(mes_referencia) FROM public.radar_ingest_state WHERE status = 'complete');
  IF v_pend <> 0 THEN
    RAISE EXCEPTION 'A5 FALHOU: % lote(s) antigo(s) sem avisado_em após o bootstrap — o 1º cron mandaria e-mail retroativo', v_pend;
  END IF;
END
$boot$;

COMMENT ON COLUMN public.radar_ingest_state.avisado_em IS
  'Instante em que o gestor foi avisado do fechamento deste lote (fornecedor_alerta). NULL = ainda não avisado. Escritor: radar_avisar_lote() (+ bootstrap único na criação da coluna, migration 20261020143000).';

CREATE OR REPLACE FUNCTION public.radar_avisar_lote(p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_espera      constant interval := interval '15 minutes';
  c_top         constant integer  := 10;
  c_score_alvo  constant smallint := 70;
  c_tela        constant text     := 'https://steu.lovable.app/radar';
  c_fmt         constant text     := 'FM999,999,999';
  v_ini         timestamptz := clock_timestamp();
  r             record;
  v_lotes       jsonb := '[]'::jsonb;
  v_janela_fim  timestamptz;
  v_ineditos_foto bigint;
  v_ineditos    bigint;
  v_ineditos_fila bigint;
  v_lote_ant    text;
  v_total_ant   integer;
  v_sairam      bigint;
  v_verificados bigint;
  v_baixas      bigint;
  v_score_lote  text;
  v_score_estado text;
  v_p_alvo      bigint;
  v_sem_score   bigint;
  v_top         text;
  v_linha_score text;
  v_linha_sairam text;
  v_linha_baixas text;
  v_titulo      text;
  v_corpo       text;
  v_alerta_id   bigint;
  v_marcados    integer;
  v_detalhe     jsonb;
BEGIN
  IF p_agora IS NULL THEN
    RAISE EXCEPTION 'radar_avisar_lote: p_agora não pode ser NULL' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT mes_referencia, total_recebido, novos, iniciado_em, finalizado_em
      FROM public.radar_ingest_state
     WHERE status = 'complete'
       AND avisado_em IS NULL
       AND finalizado_em IS NOT NULL
       AND finalizado_em <= p_agora - c_espera
     ORDER BY mes_referencia
     FOR UPDATE SKIP LOCKED
  LOOP
    -- Janela do lote: [iniciado_em deste, iniciado_em do lote seguinte) — independe de ultimo_lote.
    SELECT min(iniciado_em) INTO v_janela_fim
      FROM public.radar_ingest_state WHERE mes_referencia > r.mes_referencia;
    v_janela_fim := COALESCE(v_janela_fim, 'infinity'::timestamptz);

    -- Inéditos: N persistido no finalize; a foto atual dá a fila (quem ainda está para contatar).
    SELECT count(*),
           count(*) FILTER (WHERE NOT ja_cliente AND prospeccao_status NOT IN ('descartado', 'virou_cliente'))
      INTO v_ineditos_foto, v_ineditos_fila
      FROM public.radar_empresas
     WHERE primeira_vista_em >= r.iniciado_em AND primeira_vista_em < v_janela_fim;
    v_ineditos := COALESCE(r.novos, v_ineditos_foto);

    -- Saíram do dump: vigentes EXATAMENTE no lote anterior, ausentes neste, ainda na base (não descartadas).
    SELECT mes_referencia, total_recebido INTO v_lote_ant, v_total_ant
      FROM public.radar_ingest_state
     WHERE status = 'complete' AND mes_referencia < r.mes_referencia
     ORDER BY mes_referencia DESC LIMIT 1;
    IF v_lote_ant IS NULL THEN
      v_sairam := NULL;
      v_linha_sairam := '• Saíram do dump: sem lote anterior para comparar.';
    ELSE
      SELECT count(*) INTO v_sairam
        FROM public.radar_empresas
       WHERE ultimo_lote = v_lote_ant
         AND prospeccao_status NOT IN ('descartado', 'virou_cliente');
      v_linha_sairam := '• Saíram do dump: ' || replace(to_char(v_sairam, c_fmt), ',', '.')
        || ' de ' || replace(to_char(v_total_ant, c_fmt), ',', '.')
        || ' empresas do lote anterior (' || v_lote_ant || ') não vieram em ' || r.mes_referencia
        || ' e seguem na base sem descarte (baixas/inaptas são descartadas pela situação cadastral RFB).';
    END IF;

    -- Clientes com baixa: foto RFB DESTE lote × universo de clientes (radar ∪ documentos de cliente).
    WITH clientes AS MATERIALIZED (
      SELECT d.doc AS cnpj FROM public.radar_docs_clientes() d
      UNION
      SELECT re.cnpj FROM public.radar_empresas re WHERE re.ja_cliente
    )
    SELECT count(*), count(*) FILTER (WHERE s.situacao IN ('03', '04', '08'))
      INTO v_verificados, v_baixas
      FROM clientes c
      JOIN public.radar_situacao_cadastral s ON s.cnpj = c.cnpj AND s.lote = r.mes_referencia;
    IF v_verificados = 0 THEN
      v_linha_baixas := '• Clientes com baixa/inaptidão/suspensão: nenhum cliente com situação cadastral verificada neste lote.';
    ELSE
      v_linha_baixas := '• Clientes com baixa/inaptidão/suspensão: ' || replace(to_char(v_baixas, c_fmt), ',', '.')
        || ' de ' || replace(to_char(v_verificados, c_fmt), ',', '.')
        || ' clientes verificados neste lote → ' || c_tela;
    END IF;

    -- Score: a ÚLTIMA rodada automática do score diz qual foto avaliou (detalhes.lote_vigente).
    SELECT e.detalhes->>'lote_vigente' INTO v_score_lote
      FROM public.acoes_execucoes e
     WHERE e.acao = 'radar.score_recalcular' AND e.origem = 'automatica' AND e.status = 'sucesso'
     ORDER BY e.finalizado_em DESC NULLS LAST, e.iniciado_em DESC
     LIMIT 1;
    IF v_score_lote = r.mes_referencia THEN
      v_score_estado := 'calculado';
      SELECT count(*) FILTER (WHERE score >= c_score_alvo), count(*) FILTER (WHERE score IS NULL)
        INTO v_p_alvo, v_sem_score
        FROM public.radar_empresas
       WHERE primeira_vista_em >= r.iniciado_em AND primeira_vista_em < v_janela_fim;
      v_linha_score := '• Score ≥ ' || c_score_alvo || ': ' || replace(to_char(v_p_alvo, c_fmt), ',', '.')
        || ' de ' || replace(to_char(v_ineditos_foto, c_fmt), ',', '.') || ' inéditos'
        || CASE WHEN v_sem_score > 0 THEN ' (' || v_sem_score || ' sem score)' ELSE '' END || '.';
      SELECT string_agg(
               lpad(t.pos::text, 2, ' ') || '. ' || COALESCE(NULLIF(btrim(t.razao_social), ''), 'razão social não informada')
               || ' (' || COALESCE(NULLIF(btrim(t.municipio_nome), ''), '?') || '/' || COALESCE(t.uf, '??') || ') — score '
               || t.score || ' — ' || COALESCE(array_to_string(t.score_motivos[1:2], '; '), 'sem motivos'),
               E'\n' ORDER BY t.pos)
        INTO v_top
        FROM (SELECT row_number() OVER (ORDER BY score DESC, cnpj) AS pos,
                     razao_social, municipio_nome, uf, score, score_motivos
                FROM public.radar_empresas
               WHERE primeira_vista_em >= r.iniciado_em AND primeira_vista_em < v_janela_fim
                 AND NOT ja_cliente AND prospeccao_status NOT IN ('descartado', 'virou_cliente')
                 AND score IS NOT NULL
               ORDER BY score DESC, cnpj
               LIMIT c_top) t;
      v_top := E'\nTop ' || c_top || ' inéditos por score:' || E'\n' || COALESCE(v_top, '(nenhum inédito com score)');
    ELSIF v_score_lote > r.mes_referencia THEN
      v_score_estado := 'indisponivel';
      v_p_alvo := NULL; v_sem_score := NULL;
      v_linha_score := '• Score: indisponível para este lote — o score já reflete o lote ' || v_score_lote || '; o ranking atual está na tela.';
      v_top := '';
    ELSE
      v_score_estado := 'pendente';
      v_p_alvo := NULL; v_sem_score := NULL;
      v_linha_score := '• Score: pendente — o recálculo diário (radar_score_recalcular) ainda não avaliou este lote; o ranking vem na tela quando rodar.';
      v_top := '';
    END IF;

    v_titulo := '[Radar] lote ' || r.mes_referencia || ': ' || replace(to_char(v_ineditos, c_fmt), ',', '.')
      || ' inéditos de ' || replace(to_char(r.total_recebido, c_fmt), ',', '.');
    v_corpo :=
      'Lote ' || r.mes_referencia || ' do Radar de Clientes fechado em '
      || to_char(r.finalizado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' (BRT).' || E'\n\n'
      || '• Inéditos: ' || replace(to_char(v_ineditos, c_fmt), ',', '.') || ' de '
      || replace(to_char(r.total_recebido, c_fmt), ',', '.') || ' empresas recebidas ('
      || replace(to_char(v_ineditos_fila, c_fmt), ',', '.') || ' na fila de prospecção hoje).' || E'\n'
      || v_linha_sairam || E'\n'
      || v_linha_baixas || E'\n'
      || v_linha_score || E'\n'
      || v_top || E'\n\n'
      || 'Fila completa (inéditos primeiro): ' || c_tela || E'\n'
      || 'Fonte: dados abertos de CNPJ da RFB, dump ' || r.mes_referencia || '. Este aviso é único por lote.';

    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
    VALUES ('oben', 'outro', 'info', v_titulo, v_corpo, 'pendente_notificacao',
            jsonb_build_object('origem', 'radar_avisar_lote', 'lote', r.mes_referencia,
                               'ineditos', v_ineditos, 'ineditos_foto', v_ineditos_foto, 'ineditos_fila', v_ineditos_fila,
                               'total', r.total_recebido,
                               'sairam', v_sairam, 'total_anterior', v_total_ant, 'lote_anterior', v_lote_ant,
                               'clientes_baixa', v_baixas, 'clientes_verificados', v_verificados,
                               'score', v_score_estado, 'score_lote', v_score_lote,
                               'score_alvo', v_p_alvo, 'sem_score', v_sem_score))
    RETURNING id INTO v_alerta_id;
    IF v_alerta_id IS NULL THEN
      RAISE EXCEPTION 'radar_avisar_lote: fornecedor_alerta não materializou o aviso do lote %', r.mes_referencia
        USING ERRCODE = '25000';
    END IF;

    UPDATE public.radar_ingest_state
       SET avisado_em = p_agora
     WHERE mes_referencia = r.mes_referencia AND avisado_em IS NULL;
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
    IF v_marcados <> 1 THEN
      RAISE EXCEPTION 'radar_avisar_lote: avisado_em marcou % linha(s) para o lote % (esperado 1)', v_marcados, r.mes_referencia
        USING ERRCODE = '25000';
    END IF;

    v_detalhe := jsonb_build_object(
      'lote', r.mes_referencia, 'alerta_id', v_alerta_id,
      'ineditos', v_ineditos, 'ineditos_foto', v_ineditos_foto, 'ineditos_fila', v_ineditos_fila,
      'total', r.total_recebido,
      'sairam', v_sairam, 'lote_anterior', v_lote_ant, 'total_anterior', v_total_ant,
      'clientes_baixa', v_baixas, 'clientes_verificados', v_verificados,
      'score', v_score_estado, 'score_lote', v_score_lote, 'score_alvo', v_p_alvo, 'sem_score', v_sem_score);
    v_lotes := v_lotes || v_detalhe;
  END LOOP;

  IF jsonb_array_length(v_lotes) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.avisar_lote', 'automatica', v_ini, clock_timestamp(), 'sucesso',
            jsonb_build_object('lotes', v_lotes, 'avisados', jsonb_array_length(v_lotes)));
  END IF;

  RETURN jsonb_build_object('avisados', jsonb_array_length(v_lotes), 'lotes', v_lotes);
END;
$$;

COMMENT ON FUNCTION public.radar_avisar_lote(timestamptz) IS
  'Entrypoint de JOB: 1 aviso (fornecedor_alerta → e-mail) por lote mensal fechado, com denominador, nunca repetido (radar_ingest_state.avisado_em). p_agora = relógio controlado (prova PG17).';

-- Entrypoint de JOB: só o owner (postgres) e service_role executam — REPLACE preserva o ACL, mas o REVOKE
-- fecha as DUAS pontas (PUBLIC e anon) e nomeia authenticated.
REVOKE ALL ON FUNCTION public.radar_avisar_lote(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_avisar_lote(timestamptz) TO service_role;

-- cron.schedule por NOME regrava o comando se o job já existir (idempotente). Owner: postgres (canal MCP).
SELECT cron.schedule(
  'radar-avisar-lote-diario',
  '45 6 * * *',
  $$SELECT public.radar_avisar_lote();$$
);

DO $post$
DECLARE
  f constant text := 'public.radar_avisar_lote(timestamptz)';
  v_md5 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'radar_ingest_state' AND column_name = 'avisado_em') THEN
    RAISE EXCEPTION 'A1 FALHOU: radar_ingest_state.avisado_em ausente — a função não teria onde marcar o dedupe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'radar_avisar_lote' AND p.prosecdef) THEN
    RAISE EXCEPTION 'A2 FALHOU: radar_avisar_lote ausente ou sem SECURITY DEFINER — o cron não teria o que chamar';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('public', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated executam radar_avisar_lote — qualquer sessão dispararia e-mail ao gestor';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem EXECUTE em radar_avisar_lote';
  END IF;
  -- (A5 = bootstrap, dentro do DO $boot$ — só na criação da coluna.)
  -- Transcrição pelo canal MCP: o corpo vivo tem de ser BYTE A BYTE o deste arquivo (database.md §MCP).
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(f);
  IF v_md5 IS DISTINCT FROM '32be942a097aeed44abda7b42699645a' THEN
    RAISE EXCEPTION 'A7 FALHOU: radar_avisar_lote vivo (md5 %) não é o corpo deste arquivo — colagem incompleta ou corpo divergente', v_md5;
  END IF;
  -- Job do dono certo, neste banco, ativo, comando exato; cron.timezone vazio/UTC (schedule lido em UTC).
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-avisar-lote-diario' AND schedule = '45 6 * * *'
                    AND command = 'SELECT public.radar_avisar_lote();' AND active
                    AND username = 'postgres' AND database = current_database()) THEN
    RAISE EXCEPTION 'A6 FALHOU: cron radar-avisar-lote-diario ausente, inativo, de outro dono/banco ou fora de 45 6 * * * — o aviso nunca rodaria';
  END IF;
  IF COALESCE(current_setting('cron.timezone', true), '') NOT IN ('', 'GMT', 'UTC') THEN
    RAISE EXCEPTION 'A6b FALHOU: cron.timezone=% — o schedule 45 6 * * * deixaria de ser 06:45 UTC', current_setting('cron.timezone', true);
  END IF;
  RAISE NOTICE 'radar_avisar_lote: coluna, função (ACL fechada, md5 ok) e cron 06:45 UTC provados';
END
$post$;

COMMIT;
