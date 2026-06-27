-- ============================================================
-- 20260627180100_seg_onda1_rls_views_matview.sql
-- Hardening de segurança — Onda 1 (vazamento crítico de dados)
--
-- Fecha achados do scanner Lovable Security:
--   • "RLS Disabled in Public" + cost/pricing/tint/limbo "publicly readable" (5 tabelas)
--   • "Security Definer View" (fin_aging_pagar, fin_aging_receber, v_caca_compradores)
--   • "Materialized View in API" (customer_metrics_mv)
--
-- Seguro p/ engines: service_role e postgres (owner das tabelas) têm BYPASSRLS;
-- edge functions/cron não são afetadas. A única função que escreve no limbo_log
-- (reposicao_param_limbo_watchdog) é SECURITY DEFINER → roda como owner → imune.
-- Decisão founder (2026-06-27): TRANCAR as 5 tabelas (RLS + revoke), não dropar — reversível.
-- Idempotente: pode rodar mais de uma vez sem erro.
-- ============================================================

-- ── 1) Trancar as 5 tabelas de backup/preflight/log ─────────────────────────
-- Hoje anon (NÃO autenticado) LÊ e GRAVA custo/fórmula/preço. Com RLS habilitada e
-- sem policy, anon+authenticated ficam sem acesso via PostgREST; service_role/owner
-- seguem via BYPASSRLS. O REVOKE é defense-in-depth (remove o grant default do Supabase).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '_backup_cost_lavados_20260620',
    '_backup_cost_reset_20260622',
    '_preflight_tint',
    'reposicao_param_limbo_log',
    'tint_formulas_backup_preflip'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;

-- ── 2) Views SECURITY DEFINER → security_invoker ────────────────────────────
-- Rodavam como o owner (bypassa RLS) → anon lia agregados de aging financeiro e a
-- carteira de "caça compradores". security_invoker=on faz a view respeitar a RLS das
-- tabelas-base (fin_user_can_access p/ fin_contas_*; staff p/ profiles/sales_orders/
-- order_items). ALTER VIEW SET apenas troca a opção — NÃO recria colunas (sem risco de
-- reordenar / "cannot change name of view column").
ALTER VIEW public.fin_aging_pagar    SET (security_invoker = on);
ALTER VIEW public.fin_aging_receber  SET (security_invoker = on);
ALTER VIEW public.v_caca_compradores SET (security_invoker = on);

-- ── 3) Materialized view exposta na Data API ────────────────────────────────
-- customer_metrics_mv era legível por anon (não há RLS em matview). Revoga anon; as 3
-- telas autenticadas (useRouteContactList, customer360, useCriticaFila) seguem lendo
-- como authenticated. Silenciar 100% o lint exigiria trocar por RPC (follow-up).
REVOKE ALL ON public.customer_metrics_mv FROM anon;
