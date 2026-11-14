-- T1: tamanho (metadado) das tabelas tint com mais leitura na janela. SÓ LEITURA, sem count(*).
\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
SELECT s.relname, pg_size_pretty(pg_relation_size(c.oid)) heap, pg_size_pretty(pg_total_relation_size(c.oid)) total, c.reltuples::bigint, s.n_dead_tup, s.seq_scan, s.idx_scan, s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.autovacuum_count
FROM pg_stat_all_tables s JOIN pg_class c ON c.oid=s.relid WHERE s.schemaname='public' AND s.relname IN ('tint_formulas','tint_formula_itens','tint_staging_formulas','tint_staging_formula_itens','tint_sync_runs','tint_staging_skus','tint_sync_errors','radar_contatos') ORDER BY pg_total_relation_size(c.oid) DESC;
SELECT '#FIM-OK';
