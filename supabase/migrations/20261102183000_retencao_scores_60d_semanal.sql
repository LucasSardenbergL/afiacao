-- Plano v4, lote 11 (B1): retenção de 60 dias, semanal, em health_score_history e priority_score_log
--
-- Medido via psql-ro (2026-11-02): 434 MB + 375 MB (13% do banco), 1.247.917 linhas cada, desde
-- 2026-08-03, ~14,2k linhas/dia em cada uma. A retenção de 90 dias da 20261011120400 roda MENSAL
-- (dia 1), então a tabela chega a ~120 dias antes do corte; o run de 1º/11 apagou 607.460 linhas por
-- tabela em 37 s. Leitores INSTALADOS em prod: nenhum além do próprio expurgo (pg_proc, pg_views,
-- pg_matviews, triggers, FKs de entrada) — o escritor único segue a edge calculate-scores (INSERT).
--
-- O que muda:
--   1. private.expurgar_scores_antigos(p_dias, p_lote): mesma assinatura (sem DROP, ACL preservado),
--      defaults 60 / 10.000 e TETO de 60 lotes por tabela por chamada (≤ 600k linhas). Sem o teto,
--      um atraso maior que o statement_timeout faria a chamada inteira voltar atrás toda semana sem
--      apagar nada; com ele, cada chamada avança. Devolve 'resta_*' = o teto foi atingido com lote cheio.
--   2. cron 'expurgo-scores-farmer' passa de mensal para SEMANAL (domingo 04:30 UTC), com
--      statement_timeout e lock_timeout explícitos. Regime: ~100k linhas por tabela por semana; o 1º
--      domingo (8/11) leva o atraso de 60→90 dias (~500k por tabela, ~30 s pelo run de 1º/11).
--      Retenção efetiva: 60 a 67 dias.
--   Lock: o DELETE pega RowExclusiveLock (não conflita com o INSERT da calculate-scores) e só toca
--   linha velha que ninguém atualiza; o que o teto limita é a DURAÇÃO da transação (horizonte de
--   vacuum), e o lock_timeout impede o job de enfileirar atrás de um DDL e travar quem vem depois.
--   Os índices por data (idx_health_history_calculated_at, idx_priority_log_score_date) ficam: são o
--   caminho do corte. Os 4 índices (customer|farmer, data) sem scan ficam para depois de 7 dias de
--   contador (desde o restart de 2026-10-31 10:33 UTC).
--   Espaço: o DELETE libera para REUSO (autovacuum); o arquivo não encolhe sem VACUUM FULL — a tabela
--   para de crescer.
--
-- Aplicar: bun run db:aplicar (o executor traz a transação — este arquivo NÃO leva BEGIN/COMMIT).
-- Molde TRAVA → PRE → CREATE → PÓS: a função é VIVA; a PRE aceita só o corpo da 20261011120400
-- (md5 medido em prod) ou este. Idempotente: CREATE OR REPLACE + cron.schedule por nome.
-- Reversão: re-aplicar a função da 20261011120400 e
--   SELECT cron.schedule('expurgo-scores-farmer', '30 4 1 * *', $$SELECT private.expurgar_scores_antigos(90);$$);
-- Prova: db/test-retencao-scores-60d.sh (PG17: borda 59/61, teto de lotes, PRE, piso, fecho, falsificação).

SET LOCAL lock_timeout = '10s';

-- TRAVA: ALTER sem efeito (a volatilidade viva é VOLATILE) prende a linha de pg_proc antes da PRE ler.
DO $trava$
BEGIN
  IF to_regprocedure('private.expurgar_scores_antigos(int, int)') IS NOT NULL THEN
    ALTER FUNCTION private.expurgar_scores_antigos(int, int) VOLATILE;
  END IF;
END
$trava$;

-- PRE: corpo vivo ∈ {20261011120400 (md5 de prod, 2026-11-02), este}. Ausente aborta.
DO $pre$
DECLARE v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('private.expurgar_scores_antigos(int, int)');
  IF v_vivo IS NULL OR v_vivo NOT IN ('0bfea5073c058c213deb795422bbd2ec', '214e3205263b7a89d01d23eca4ed2932') THEN
    RAISE EXCEPTION 'B1_PRE_FALHOU: expurgar_scores_antigos vivo (md5 %) não é o da 20261011120400 nem este', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION private.expurgar_scores_antigos(p_dias int DEFAULT 60, p_lote int DEFAULT 10000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  c_max_lotes CONSTANT int := 60;
  v_corte timestamptz;
  v_h bigint := 0;
  v_p bigint := 0;
  v_resta_h boolean;
  v_resta_p boolean;
  n bigint := 0;
BEGIN
  IF p_dias IS NULL OR p_dias < 30 THEN
    RAISE EXCEPTION 'retencao_minima: p_dias=% < 30', p_dias USING ERRCODE = '22023';
  END IF;
  IF p_lote IS NULL OR p_lote NOT BETWEEN 1 AND 50000 THEN
    RAISE EXCEPTION 'lote_invalido: p_lote=%', p_lote USING ERRCODE = '22023';
  END IF;
  v_corte := now() - make_interval(days => p_dias);

  FOR i IN 1..c_max_lotes LOOP
    DELETE FROM public.health_score_history
     WHERE id IN (SELECT id FROM public.health_score_history WHERE calculated_at < v_corte LIMIT p_lote);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_h := v_h + n;
    EXIT WHEN n < p_lote;
  END LOOP;
  v_resta_h := (n = p_lote);

  n := 0;
  FOR i IN 1..c_max_lotes LOOP
    DELETE FROM public.priority_score_log
     WHERE id IN (SELECT id FROM public.priority_score_log WHERE score_date < v_corte::date LIMIT p_lote);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_p := v_p + n;
    EXIT WHEN n < p_lote;
  END LOOP;
  v_resta_p := (n = p_lote);

  RETURN jsonb_build_object('corte', v_corte, 'health_score_history', v_h, 'priority_score_log', v_p,
                            'resta_health', v_resta_h, 'resta_priority', v_resta_p);
END;
$function$;

REVOKE ALL ON FUNCTION private.expurgar_scores_antigos(int, int) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('expurgo-scores-farmer', '30 4 * * 0',
  $cron$SET statement_timeout = '5min'; SET lock_timeout = '5s'; SELECT private.expurgar_scores_antigos(60, 10000);$cron$);

-- Pós-condição: corpo e defaults novos, índices por data válidos, função fechada para
-- anon/authenticated, exatamente 1 job semanal ativo com o comando certo.
DO $post$
DECLARE v_md5 text; v_args text; v_idx int; v_job int;
BEGIN
  SELECT md5(p.prosrc), pg_get_function_arguments(p.oid) INTO v_md5, v_args FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('private.expurgar_scores_antigos(int, int)');
  SELECT count(*) INTO v_idx FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
   WHERE ix.indisvalid AND i.relname IN ('idx_health_history_calculated_at', 'idx_priority_log_score_date');
  SELECT count(*) INTO v_job FROM cron.job
   WHERE jobname = 'expurgo-scores-farmer' AND schedule = '30 4 * * 0' AND active
     AND command LIKE '%statement_timeout%lock_timeout%private.expurgar_scores_antigos(60, 10000)%';
  IF v_md5 IS DISTINCT FROM '214e3205263b7a89d01d23eca4ed2932'
     OR v_args IS DISTINCT FROM 'p_dias integer DEFAULT 60, p_lote integer DEFAULT 10000'
     OR v_idx <> 2 OR v_job <> 1
     OR (SELECT count(*) FROM cron.job WHERE jobname = 'expurgo-scores-farmer') <> 1
     OR has_function_privilege('anon', 'private.expurgar_scores_antigos(int, int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.expurgar_scores_antigos(int, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B1_POS_FALHOU md5=% args=% idx=% job=%', v_md5, v_args, v_idx, v_job;
  END IF;
END
$post$;
