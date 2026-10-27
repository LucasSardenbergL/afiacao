-- Corpo de APPLY (bun run db:aplicar) da migration supabase/migrations/20261027010000_radar_situacao_por_cron.sql:
-- os mesmos bytes SEM o envelope BEGIN/COMMIT (o db:aplicar é a transação). A postcondição exige o md5 dos corpos.
-- =============================================================================
-- Radar: situação cadastral RFB aplicada por JOB pg_cron, fora do request da edge
-- =============================================================================
-- Incidente (2026-10-21, lote 2026-09 — docs/historico/radar-finalize-timeout-2026-09.md): o `finalize`
-- da edge radar-ingest v1.2 chamava `radar_aplicar_situacao` por PostgREST como service_role, que
-- herda o statement_timeout=8s do authenticator; o passo (a) regrava ~553k linhas de radar_empresas
-- (~140s; a função inteira ~4-5 min) → 57014, lote 'error', recuperado à mão. Todo lote repete isso:
-- `rfb_situacao_lote` muda todo mês.
--
-- O que entra (idempotente; envelope BEGIN/COMMIT para SQL Editor/MCP; postcondição DO $post$):
--   1. `radar_ingest_state.situacao_aplicada_fechamento` / `situacao_aplicada_em` / `situacao_resultado`
--      — marca da aplicação (colunas dedicadas, 1 escritor: radar_aplicar_situacao_pendente). A CHAVE é
--      `situacao_aplicada_fechamento` = o `finalizado_em` do fechamento aplicado: pendente ⇔ `complete` e
--      chave ≠ finalizado_em. Igualdade de valor, nunca comparação de relógios (Deno × banco).
--      Bootstrap SÓ na criação: todo lote já `complete` foi aplicado (2026-09 à mão em 21/10) ou é
--      anterior à v1.2 (sem linhas de situação) → chave = finalizado_em, resultado {"bootstrap": true}.
--   2. `radar_aplicar_situacao_pendente(p_agora)` — entrypoint do JOB. Só o lote `complete` MAIS NOVO é
--      aplicado; pendente mais velho é marcado SUPERADO sem efeito (aplicar outubro depois de novembro
--      descartaria lead que novembro diz ativo — a guarda `vigente` compara com a foto já aplicada, não
--      com a mais nova disponível; Codex P1, 2026-10-27). Re-rodar = no-op pela chave;
--      radar_aplicar_situacao já é idempotente por si (fotos/leads/novos = 0).
--      Tudo numa transação: aplicação + marca + ledger (radar.aplicar_situacao) ou nada.
--   3. cron `radar-aplicar-situacao-diario` 06:05 UTC (03:05 BRT), como postgres, com
--      `SET statement_timeout` explícito (30 min ≈ 6× o medido) — antes do recruzar (06:15), do score
--      (06:30) e do aviso (06:45). Locks de linha em radar_empresas por ~5 min: madrugada de propósito.
--   4. `radar_avisar_lote` — corpo de 20261020143000 + espera a aplicação do lote: o e-mail não sai antes
--      dos descartes/alerta. Se a aplicação não vier em 30 h do fechamento (job falhando ou desativado —
--      ≥ 1 retentativa), o aviso sai ASSIM MESMO, severidade 'atencao', dizendo que a situação NÃO foi
--      aplicada: a pendência nunca fica muda.
--
-- Consequência aceita (founder, opção 1): descarte de lead baixado e alerta de cliente irregular saem
-- na manhã SEGUINTE ao finalize (a carga de segunda fecha ~08:00-14:00 UTC); o aviso do lote já saía
-- no dia seguinte às 06:45. A edge v1.3 deixa de chamar radar_aplicar_situacao — deploy DEPOIS desta.
--
-- Prova PG17: db/test-radar-situacao-por-cron.sh (nucleo-ci.txt, --falsificar).
-- Diário: docs/historico/radar-finalize-timeout-2026-09.md (Pendência → resolvida).
-- =============================================================================

-- 1) Marca da aplicação (1 escritor) ----------------------------------------------------------------
DO $boot$
DECLARE
  v_pend integer;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'radar_ingest_state' AND column_name = 'situacao_aplicada_fechamento') THEN
    RAISE NOTICE 'radar_ingest_state.situacao_aplicada_fechamento já existe — bootstrap pulado (pendências preservadas)';
    RETURN;
  END IF;
  ALTER TABLE public.radar_ingest_state ADD COLUMN situacao_aplicada_fechamento timestamptz;
  ALTER TABLE public.radar_ingest_state ADD COLUMN situacao_aplicada_em timestamptz;
  ALTER TABLE public.radar_ingest_state ADD COLUMN situacao_resultado jsonb;
  UPDATE public.radar_ingest_state
     SET situacao_aplicada_fechamento = finalizado_em, situacao_aplicada_em = finalizado_em,
         situacao_resultado = jsonb_build_object('lote', mes_referencia, 'bootstrap', true)
   WHERE status = 'complete' AND finalizado_em IS NOT NULL;
  SELECT count(*) INTO v_pend FROM public.radar_ingest_state
   WHERE status = 'complete' AND finalizado_em IS NOT NULL
     AND situacao_aplicada_fechamento IS DISTINCT FROM finalizado_em;
  IF v_pend IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'B1 FALHOU: % lote(s) complete sem marca após o bootstrap — o 1º job reaplicaria lote já aplicado', v_pend;
  END IF;
END
$boot$;

COMMENT ON COLUMN public.radar_ingest_state.situacao_aplicada_fechamento IS
  'finalizado_em do fechamento cuja situação cadastral RFB foi aplicada (ou superada). Pendente ⇔ status complete e este valor ≠ finalizado_em. 1 escritor: radar_aplicar_situacao_pendente.';
COMMENT ON COLUMN public.radar_ingest_state.situacao_aplicada_em IS
  'Quando o job marcou a aplicação (relógio do banco; informativo — a chave é situacao_aplicada_fechamento). 1 escritor: radar_aplicar_situacao_pendente.';
COMMENT ON COLUMN public.radar_ingest_state.situacao_resultado IS
  'Retorno de radar_aplicar_situacao na aplicação marcada, {"superado_por": lote} quando um lote mais novo já existia, ou {"bootstrap": true}. 1 escritor: radar_aplicar_situacao_pendente.';

-- 2) Entrypoint do job ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao_pendente(p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ini        timestamptz := clock_timestamp();
  r            record;
  v_mais_novo  text;
  v_res        jsonb;
  v_lotes      jsonb := '[]'::jsonb;
  v_aplicados  integer := 0;
  v_marcados   integer;
BEGIN
  IF p_agora IS NULL THEN
    RAISE EXCEPTION 'radar_aplicar_situacao_pendente: p_agora não pode ser NULL' USING ERRCODE = '22023';
  END IF;

  SELECT max(mes_referencia) INTO v_mais_novo FROM public.radar_ingest_state WHERE status = 'complete';

  FOR r IN
    SELECT mes_referencia, finalizado_em
      FROM public.radar_ingest_state
     WHERE status = 'complete'
       AND finalizado_em IS NOT NULL
       AND situacao_aplicada_fechamento IS DISTINCT FROM finalizado_em
     ORDER BY mes_referencia
     FOR UPDATE SKIP LOCKED
  LOOP
    IF r.mes_referencia = v_mais_novo THEN
      v_res := public.radar_aplicar_situacao(r.mes_referencia, p_agora);
      v_aplicados := v_aplicados + 1;
    ELSE
      -- Foto superada: aplicar descartaria/alertaria por situação que o lote mais novo já pode ter revertido.
      v_res := jsonb_build_object('lote', r.mes_referencia, 'superado_por', v_mais_novo);
    END IF;

    UPDATE public.radar_ingest_state
       SET situacao_aplicada_fechamento = r.finalizado_em, situacao_aplicada_em = p_agora,
           situacao_resultado = v_res
     WHERE mes_referencia = r.mes_referencia AND status = 'complete' AND finalizado_em = r.finalizado_em;
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
    IF v_marcados <> 1 THEN
      RAISE EXCEPTION 'radar_aplicar_situacao_pendente: marcou % linha(s) para o lote % (esperado 1)', v_marcados, r.mes_referencia
        USING ERRCODE = '25000';
    END IF;
    v_lotes := v_lotes || v_res;
  END LOOP;

  IF jsonb_array_length(v_lotes) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.aplicar_situacao', 'automatica', v_ini, clock_timestamp(), 'sucesso',
            jsonb_build_object('lotes', v_lotes, 'aplicados', v_aplicados, 'marcados', jsonb_array_length(v_lotes)));
  END IF;

  RETURN jsonb_build_object('aplicados', v_aplicados, 'marcados', jsonb_array_length(v_lotes), 'lotes', v_lotes);
END;
$$;

COMMENT ON FUNCTION public.radar_aplicar_situacao_pendente(timestamptz) IS
  'Entrypoint de JOB (cron 06:05 UTC): aplica radar_aplicar_situacao ao lote complete mais novo pendente (situacao_aplicada_fechamento ≠ finalizado_em), marca superado o pendente mais velho, grava a marca. Fora do request da edge (8s do PostgREST). p_agora = relógio controlado (prova PG17).';

-- Só o owner (postgres, o cron) executa: sem GRANT a service_role — pelo PostgREST cairia nos 8s de novo.
REVOKE ALL ON FUNCTION public.radar_aplicar_situacao_pendente(timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- 3) Job: SET explícito — o postgres não tem statement_timeout de papel, mas o job não depende disso.
SELECT cron.schedule(
  'radar-aplicar-situacao-diario',
  '5 6 * * *',
  $$SET statement_timeout = '30min'; SELECT public.radar_aplicar_situacao_pendente();$$
);

-- 4) Aviso do lote só depois da aplicação (ou, sem ela em 30 h, dizendo que não houve) -------------
CREATE OR REPLACE FUNCTION public.radar_avisar_lote(p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_espera      constant interval := interval '15 minutes';
  c_espera_sit  constant interval := interval '30 hours';  -- ≥ 1 retentativa do job das 06:05 depois do fechamento
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
  v_sit_aplicada boolean;
  v_linha_situacao text;
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
    SELECT mes_referencia, total_recebido, novos, iniciado_em, finalizado_em, situacao_aplicada_fechamento
      FROM public.radar_ingest_state
     WHERE status = 'complete'
       AND avisado_em IS NULL
       AND finalizado_em IS NOT NULL
       AND finalizado_em <= p_agora - c_espera
       -- Situação do lote aplicada pelo job (20261027010000) — ou 30 h sem ela: o aviso sai dizendo isso.
       AND (situacao_aplicada_fechamento = finalizado_em OR finalizado_em <= p_agora - c_espera_sit)
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

    v_sit_aplicada := r.situacao_aplicada_fechamento IS NOT DISTINCT FROM r.finalizado_em;
    IF v_sit_aplicada THEN
      v_linha_situacao := '';
    ELSE
      v_linha_situacao := E'\n' || '• ATENÇÃO: a situação cadastral RFB deste lote NÃO foi aplicada (job radar-aplicar-situacao-diario sem sucesso há mais de 30 h)'
        || ' — leads baixados/inaptos seguem na fila e clientes irregulares não foram avisados. Recuperação: docs/historico/radar-finalize-timeout-2026-09.md.';
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
      || v_linha_baixas || v_linha_situacao || E'\n'
      || v_linha_score || E'\n'
      || v_top || E'\n\n'
      || 'Fila completa (inéditos primeiro): ' || c_tela || E'\n'
      || 'Fonte: dados abertos de CNPJ da RFB, dump ' || r.mes_referencia || '. Este aviso é único por lote.';

    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
    VALUES ('oben', 'outro', CASE WHEN v_sit_aplicada THEN 'info' ELSE 'atencao' END, v_titulo, v_corpo, 'pendente_notificacao',
            jsonb_build_object('origem', 'radar_avisar_lote', 'lote', r.mes_referencia,
                               'ineditos', v_ineditos, 'ineditos_foto', v_ineditos_foto, 'ineditos_fila', v_ineditos_fila,
                               'total', r.total_recebido,
                               'sairam', v_sairam, 'total_anterior', v_total_ant, 'lote_anterior', v_lote_ant,
                               'clientes_baixa', v_baixas, 'clientes_verificados', v_verificados,
                               'score', v_score_estado, 'score_lote', v_score_lote,
                               'score_alvo', v_p_alvo, 'sem_score', v_sem_score,
                               'situacao_aplicada', v_sit_aplicada))
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
      'score', v_score_estado, 'score_lote', v_score_lote, 'score_alvo', v_p_alvo, 'sem_score', v_sem_score,
      'situacao_aplicada', v_sit_aplicada);
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
  'Entrypoint de JOB: 1 aviso (fornecedor_alerta → e-mail) por lote mensal fechado, com denominador, nunca repetido (radar_ingest_state.avisado_em); espera a situação cadastral aplicada pelo job (situacao_aplicada_fechamento) ou, 30 h sem ela, avisa com severidade atencao dizendo que não foi aplicada. p_agora = relógio controlado (prova PG17).';

-- REPLACE preserva o ACL; o REVOKE reemitido fecha as DUAS pontas (PUBLIC e anon) e nomeia authenticated.
REVOKE ALL ON FUNCTION public.radar_avisar_lote(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_avisar_lote(timestamptz) TO service_role;

-- 5) Postcondição ---------------------------------------------------------------------------------
DO $post$
DECLARE
  f_pend  constant text := 'public.radar_aplicar_situacao_pendente(timestamptz)';
  f_aviso constant text := 'public.radar_avisar_lote(timestamptz)';
  v_md5   text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'radar_ingest_state'
         AND column_name IN ('situacao_aplicada_fechamento', 'situacao_aplicada_em', 'situacao_resultado')) IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'P1 FALHOU: colunas de marca da aplicação ausentes em radar_ingest_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(f_pend) AND prosecdef) THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_aplicar_situacao_pendente ausente ou sem SECURITY DEFINER — o cron não teria o que chamar';
  END IF;
  IF has_function_privilege('anon', f_pend, 'EXECUTE')
     OR has_function_privilege('authenticated', f_pend, 'EXECUTE')
     OR has_function_privilege('public', f_pend, 'EXECUTE')
     OR has_function_privilege('service_role', f_pend, 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: radar_aplicar_situacao_pendente executável fora do owner — descarte em massa por qualquer sessão';
  END IF;
  IF has_function_privilege('anon', f_aviso, 'EXECUTE')
     OR has_function_privilege('authenticated', f_aviso, 'EXECUTE')
     OR has_function_privilege('public', f_aviso, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f_aviso, 'EXECUTE') THEN
    RAISE EXCEPTION 'P4 FALHOU: ACL de radar_avisar_lote aberta ou sem service_role';
  END IF;
  -- Transcrição pelo canal MCP: o corpo vivo tem de ser BYTE A BYTE o deste arquivo (database.md §MCP).
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(f_pend);
  IF v_md5 IS DISTINCT FROM 'a99fd7dbdd0c8590698546b162f1a68f' THEN
    RAISE EXCEPTION 'P5 FALHOU: radar_aplicar_situacao_pendente vivo (md5 %) não é o corpo deste arquivo', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(f_aviso);
  IF v_md5 IS DISTINCT FROM '0c52be46f0a7f5ac69258e9e81360982' THEN
    RAISE EXCEPTION 'P6 FALHOU: radar_avisar_lote vivo (md5 %) não é o corpo deste arquivo', v_md5;
  END IF;
  -- Job do dono certo, neste banco, ativo, comando exato; cron.timezone vazio/UTC (schedule lido em UTC).
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-aplicar-situacao-diario' AND schedule = '5 6 * * *'
                    AND command = 'SET statement_timeout = ''30min''; SELECT public.radar_aplicar_situacao_pendente();'
                    AND active AND username = 'postgres' AND database = current_database()) THEN
    RAISE EXCEPTION 'P7 FALHOU: cron radar-aplicar-situacao-diario ausente, inativo, de outro dono/banco, fora de 5 6 * * * ou sem o statement_timeout — a situação nunca seria aplicada';
  END IF;
  IF COALESCE(current_setting('cron.timezone', true), '') NOT IN ('', 'GMT', 'UTC') THEN
    RAISE EXCEPTION 'P8 FALHOU: cron.timezone=% — o schedule 5 6 * * * deixaria de ser 06:05 UTC', current_setting('cron.timezone', true);
  END IF;
  RAISE NOTICE 'radar situação por cron: colunas, função do job (ACL só owner, md5 ok), aviso (md5 ok) e cron 06:05 UTC provados';
END
$post$;

