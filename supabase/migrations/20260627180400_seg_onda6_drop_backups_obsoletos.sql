-- ============================================================
-- 20260627180400_seg_onda6_drop_backups_obsoletos.sql
-- Hardening de segurança — Onda 6 (limpeza dos backups obsoletos)
--
-- Dropa 4 das 5 tabelas trancadas na Onda 1 (libera ~104 MB). Integridade do
-- dado-vivo CONFIRMADA via psql-ro ANTES do drop (2026-06-27):
--   • product_costs (vivo): 3588 linhas, 3588 com cost_final preenchido.
--     _backup_cost_lavados_20260620 (1804) e _backup_cost_reset_20260622 (1309)
--     eram snapshots PARCIAIS de produtos afetados por operações de custo — o
--     vivo está completo e maior → backups descartáveis.
--   • tint_formulas (vivo): 965.720 linhas, atualizado (último 2026-06-26).
--     tint_formulas_backup_preflip (481.721) era snapshot pré-flip de RLS — o
--     vivo está íntegro e com o dobro das linhas → descartável (103 MB).
--   • _preflight_tint: 1 linha de debug (run única de 2026-06-15) → descartável.
--
-- NÃO dropa reposicao_param_limbo_log: é LOG ATIVO de série temporal (o watchdog
-- reposicao_param_limbo_watchdog escreve diariamente; último registro 2026-06-27).
-- Fica apenas trancado (RLS+revoke) pela Onda 1.
--
-- Idempotente (DROP ... IF EXISTS). Aplicar SÓ após a Onda 1 — é DESTRUTIVO.
-- ============================================================
DROP TABLE IF EXISTS public._backup_cost_lavados_20260620;
DROP TABLE IF EXISTS public._backup_cost_reset_20260622;
DROP TABLE IF EXISTS public._preflight_tint;
DROP TABLE IF EXISTS public.tint_formulas_backup_preflip;
