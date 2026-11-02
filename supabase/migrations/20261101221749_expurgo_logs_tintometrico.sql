-- B4 (plano v4, lote 12): retenção de tint_sync_runs (30 d) e tint_sync_errors (60 d).
--
-- ⚠️ NÃO auto-aplica (nome custom). Caminho: `bun run db:aplicar <este arquivo> --ensaio`, depois sem
-- --ensaio; a transação é do executor, por isso o arquivo não leva BEGIN/COMMIT.
-- Prova: db/test-expurgo-logs-tint.sh (PG17: linha referenciada fica, borda, lotes, guarda de FK, falsificação).
--
-- Medido via psql-ro (2026-11-01), sem expurgo nenhum até aqui:
--   tint_sync_runs   133.979 linhas / 122 MB desde 2026-03-29, +4,4k/semana (o tick de 15 s cria run)
--   tint_sync_errors  90.995 linhas / 115 MB desde 2026-06-12, +54/semana (74 MB é error_details)
-- Se esta migration rodasse agora: 95.990 runs e 37.660 erros sairiam.
--
-- Janelas (leitores levantados em src/, edges, funções SQL e views — nenhuma view lê as tabelas):
--   runs 30 d — a idempotência da tint-sync-agent só precisa da linha DURANTE o ciclo: a chave é um UUID
--     por lote por ciclo (connector/sayersync), reenviada só no backoff do mesmo POST; o ciclo seguinte gera
--     chave nova. As telas leem 24 h (useTintAlertas) ou as últimas 200/50 (TintSyncRuns, TintIntegrations);
--     tint_promote_sync_run olha 24 h, tint_receita_versoes_capturar 2 d. 30 d é folga de auditoria.
--   erros 60 d — o card de rejeições lê 24 h e a tela do run lê o run selecionado; o resto é investigação de
--     rejeição da fonte (docs/agent/tintometrico.md), que já precisou de semanas de histórico. Daqui em
--     diante o volume é ~54/semana: a janela maior quase não custa.
--   Run com erro AINDA retido fica junto (o erro é filho dele): o contexto do erro não some antes do erro.
--
-- tint_sync_runs é PAI de 14 tabelas por FK — 12 com ON DELETE CASCADE (staging) e 2 NO ACTION
-- (tint_staging_precos_base, tint_reconciliation_runs). O tint_staging_purge guarda PARA SEMPRE a linha
-- mais recente por chave, que a promoção relê; apagar run por idade cascatearia e apagaria essa linha.
-- Por isso o expurgo só apaga run que não tem NENHUMA linha filha, lendo as FKs do catálogo a cada
-- chamada (FK nova fica protegida sem mexer aqui), e só run terminado (status complete/error) com
-- promocao_status NULL/promovido/descartado — pendente e erro são a fila da promoção e o alarme do
-- watchdog, que não podem sumir pelo tempo.
--
-- Índices: o gatilho de RI de cada DELETE no pai busca a linha filha por sync_run_id; sem índice, cada
-- run apagado varre a filha inteira (tint_staging_formula_itens: 497k linhas). 6 filhas não têm — as 5
-- vazias custam nada e a formula_itens leva ~segundos de SHARE lock (bloqueia só INSERT de staging). A
-- função RECUSA rodar se alguma filha ficar sem índice (55000), em vez de virar seq scan por linha.
-- Mais created_at de tint_sync_errors para o corte (runs usa idx_tint_sync_runs_started_at, que existe).
--
-- tint_importacoes fica FORA: a única filha é tint_formulas.importacao_id (NO ACTION, sem índice) e o
-- DELETE exigiria indexar 1M linhas / 993 MB que a promoção reescreve (~489k updates/semana, trocando o
-- importacao_id a cada upsert). Isso mexe no custo da promoção, que o corte M-43 deixou intocada. A tabela
-- é 39 MB e cresce ~1,5 MB/semana.
--
-- Não pega o advisory lock do tint-promocao-tick (o tint_staging_purge pega): nada aqui toca o que a
-- promoção lê — ela lê run pendente/erro por id e a staging mais recente, ambos fora do corte.
--
-- Lotes: cron de hora em hora, ≤ 5 lotes de 2.000 por tabela por chamada (≤ 10k linhas, transação curta;
-- o atraso inicial de ~96k runs se esgota em ~10 h). SQL puro, sem net.http_post; o comando do cron traz
-- statement_timeout e lock_timeout explícitos. FOR UPDATE SKIP LOCKED: linha travada fica para a próxima.
-- Espaço: o DELETE libera para REUSO (autovacuum); o arquivo não encolhe sem VACUUM FULL — e não precisa.
--
-- Reversão: SELECT cron.unschedule('expurgo-logs-tint'); DROP FUNCTION private.expurgar_logs_tint(int, int, int, int);

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_tint_sync_errors_created_at
  ON public.tint_sync_errors (created_at);
CREATE INDEX IF NOT EXISTS idx_tint_staging_formula_itens_sync_run_id
  ON public.tint_staging_formula_itens (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tint_staging_preparacao_itens_sync_run_id
  ON public.tint_staging_preparacao_itens (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tint_staging_cores_catalogo_sync_run_id
  ON public.tint_staging_cores_catalogo (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tint_staging_cores_personalizadas_sync_run_id
  ON public.tint_staging_cores_personalizadas (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tint_staging_precos_base_sync_run_id
  ON public.tint_staging_precos_base (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tint_reconciliation_runs_sync_run_id
  ON public.tint_reconciliation_runs (sync_run_id);

CREATE OR REPLACE FUNCTION private.expurgar_logs_tint(
  p_dias_runs int DEFAULT 30, p_dias_erros int DEFAULT 60, p_lote int DEFAULT 2000, p_max_lotes int DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_corte_runs  timestamptz;
  v_corte_erros timestamptz;
  v_filhas text := '';
  v_sql    text;
  v_runs   bigint := 0;
  v_erros  bigint := 0;
  v_resta  boolean := false;
  r record;
  n bigint;
BEGIN
  IF p_dias_runs IS NULL OR p_dias_runs < 30 OR p_dias_erros IS NULL OR p_dias_erros < 30 THEN
    RAISE EXCEPTION 'retencao_minima: runs=% erros=% (piso 30 dias)', p_dias_runs, p_dias_erros USING ERRCODE = '22023';
  END IF;
  IF p_lote IS NULL OR p_lote NOT BETWEEN 1 AND 10000 OR p_max_lotes IS NULL OR p_max_lotes NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'lote_invalido: p_lote=% p_max_lotes=%', p_lote, p_max_lotes USING ERRCODE = '22023';
  END IF;
  v_corte_runs  := now() - make_interval(days => p_dias_runs);
  v_corte_erros := now() - make_interval(days => p_dias_erros);

  -- Toda FK que aponta para tint_sync_runs vira um NOT EXISTS; FK composta ou sem índice recusa a chamada.
  FOR r IN
    SELECT c.conrelid::regclass AS filha, c.conkey, a.attname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.tint_sync_runs'::regclass
     ORDER BY 1
  LOOP
    IF cardinality(r.conkey) <> 1 THEN
      RAISE EXCEPTION 'expurgo_tint_fk_composta: %', r.filha USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_index ix
                    WHERE ix.indrelid = r.filha AND ix.indkey[0] = r.conkey[1]
                      AND ix.indisvalid AND ix.indpred IS NULL) THEN
      RAISE EXCEPTION 'expurgo_tint_fk_sem_indice: %.%', r.filha, r.attname USING ERRCODE = '55000';
    END IF;
    v_filhas := v_filhas || format(' AND NOT EXISTS (SELECT 1 FROM %s f WHERE f.%I = s.id)', r.filha, r.attname);
  END LOOP;

  -- 1º os erros: run cujo último erro saiu agora já pode sair no passo 2 da mesma chamada.
  FOR i IN 1..p_max_lotes LOOP
    DELETE FROM public.tint_sync_errors
     WHERE id IN (SELECT e.id FROM public.tint_sync_errors e
                   WHERE e.created_at < v_corte_erros
                   ORDER BY e.created_at LIMIT p_lote
                   FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_erros := v_erros + n;
    IF n < p_lote THEN EXIT; END IF;
    IF i = p_max_lotes THEN v_resta := true; END IF;
  END LOOP;

  v_sql := 'DELETE FROM public.tint_sync_runs WHERE id IN ('
        || 'SELECT s.id FROM public.tint_sync_runs s'
        || ' WHERE s.started_at < $1'
        || ' AND s.status IN (''complete'', ''error'')'
        || ' AND (s.promocao_status IS NULL OR s.promocao_status IN (''promovido'', ''descartado''))'
        || v_filhas
        || ' ORDER BY s.started_at LIMIT $2 FOR UPDATE SKIP LOCKED)';
  FOR i IN 1..p_max_lotes LOOP
    EXECUTE v_sql USING v_corte_runs, p_lote;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_runs := v_runs + n;
    IF n < p_lote THEN EXIT; END IF;
    IF i = p_max_lotes THEN v_resta := true; END IF;
  END LOOP;

  RETURN jsonb_build_object('corte_runs', v_corte_runs, 'corte_erros', v_corte_erros,
                            'tint_sync_errors', v_erros, 'tint_sync_runs', v_runs, 'resta', v_resta);
END;
$function$;

REVOKE ALL ON FUNCTION private.expurgar_logs_tint(int, int, int, int) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('expurgo-logs-tint', '41 * * * *',
  $cron$SET statement_timeout = '2min'; SET lock_timeout = '5s'; SELECT private.expurgar_logs_tint(30, 60, 2000, 5);$cron$);

-- Pós-condição: índices válidos, NENHUMA filha de tint_sync_runs sem índice (o predicado da guarda),
-- função fechada para anon/authenticated, 1 job ativo com o comando certo.
DO $post$
DECLARE v_idx int; v_sem_indice int; v_job int;
BEGIN
  SELECT count(*) INTO v_idx FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
   WHERE ix.indisvalid AND i.relname IN (
     'idx_tint_sync_errors_created_at', 'idx_tint_staging_formula_itens_sync_run_id',
     'idx_tint_staging_preparacao_itens_sync_run_id', 'idx_tint_staging_cores_catalogo_sync_run_id',
     'idx_tint_staging_cores_personalizadas_sync_run_id', 'idx_tint_staging_precos_base_sync_run_id',
     'idx_tint_reconciliation_runs_sync_run_id');
  SELECT count(*) INTO v_sem_indice FROM pg_constraint c
   WHERE c.contype = 'f' AND c.confrelid = 'public.tint_sync_runs'::regclass
     AND NOT EXISTS (SELECT 1 FROM pg_index ix
                      WHERE ix.indrelid = c.conrelid AND ix.indkey[0] = c.conkey[1]
                        AND ix.indisvalid AND ix.indpred IS NULL);
  SELECT count(*) INTO v_job FROM cron.job
   WHERE jobname = 'expurgo-logs-tint' AND schedule = '41 * * * *' AND active
     AND command LIKE '%statement_timeout%lock_timeout%private.expurgar_logs_tint(30, 60, 2000, 5)%';
  IF v_idx <> 7 OR v_sem_indice <> 0 OR v_job <> 1
     OR has_function_privilege('anon', 'private.expurgar_logs_tint(int, int, int, int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.expurgar_logs_tint(int, int, int, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B4_POS_FALHOU idx=% fk_sem_indice=% job=%', v_idx, v_sem_indice, v_job;
  END IF;
END
$post$;
