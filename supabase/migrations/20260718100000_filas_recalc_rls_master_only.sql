-- money-path (AUTORIZAÇÃO RLS: visibilidade do vínculo cliente↔vendedor mascarado).
-- FU3 do #1398 — docs/superpowers/specs/2026-07-17-carteira-rls-eligible-visibilidade-design.md §8-FU3.
--
-- PROBLEMA (achado Codex xhigh; medido em prod 2026-07-18): as policies de
-- score_recalc_queue e visit_score_recalc_queue eram broad-staff
-- (`has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee')`). Os writers
-- enfileiram os pares (customer_user_id, farmer_id) INCLUSIVE de clientes
-- eligible=false — decisão DELIBERADA do #1398 (o recompute segue rodando para que a
-- máscara seja reversível). Logo qualquer funcionário lia, por
-- `GET /rest/v1/score_recalc_queue`, exatamente o vínculo que a máscara existe para
-- esconder. Para o caso identidade-ambígua, o vínculo É o segredo.
-- Efeito medido: 2.624 linhas / 871 clientes / 3 owners mascarados legíveis.
--
-- ⚠️ A fila NÃO é transiente. O consumidor faz UPDATE de `processed_at`, NUNCA DELETE
-- (supabase/functions/scoring-recalc-client/index.ts) → visit_score_recalc_queue
-- acumulou 22.837 linhas. É arquivo histórico permanente de vínculos, não janela de
-- minutos — o que agrava o achado em vez de aliviá-lo.
--
-- POR QUE master-only NÃO QUEBRA NADA (verificado, não presumido):
--  (a) nenhuma UI lê as filas — grep em src/ = 0 ocorrências (só o types.ts gerado);
--  (b) os consumidores (edges scoring-recalc-client / visit-score-recalc-client) usam
--      SUPABASE_SERVICE_ROLE_KEY, e service_role tem BYPASSRLS → independem de policy;
--  (c) os 5 writers — enqueue_score_recalc_from_{call,sinais},
--      enqueue_visit_score_recalc_from_{visit,client_score} e
--      reverter_exclusao_fornecedor — são TODOS SECURITY DEFINER → o INSERT roda como
--      o owner. A policy INSERT é portanto VESTIGIAL: só habilitava um funcionário a
--      injetar linhas na fila por PostgREST (BFLA de escrita). Estreitada junto;
--  (d) as views score_recalc_pending / visit_score_recalc_pending são
--      `security_invoker=on` → leem como o CALLER → herdam esta RLS. Fechar a tabela
--      fecha a view (#1246: a folha é o elo).
--
-- POR QUE master-only e NÃO carteira-scoped: `carteira_visivel_para(customer_user_id,…)`
-- varia POR LINHA → não é envolvível em InitPlan → SECURITY DEFINER reavaliado linha a
-- linha em 22.837 linhas (o anti-pattern de docs/agent/database.md §4, que já causou
-- 500 no PostgREST). `has_role(auth.uid(),'master')` é constante por query → o wrap
-- `(SELECT …)` força InitPlan 1×. E como NENHUM leitor legítimo existe, recall zero é o
-- correto (money-path §1: precisão > recall).
--
-- Master-as-auditor é o default vigente do modelo de carteira (spec §8-FU4).
--
-- Idempotente: DROP POLICY IF EXISTS (nome antigo E novo) + CREATE, em transação única
-- (atômica → sem janela sem-policy; re-rodar é seguro).
-- Prova: db/test-filas-recalc-rls-master-only.sh (PG17, falsificável).

BEGIN;

-- ── score_recalc_queue ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can view recalc queue"    ON public.score_recalc_queue;
DROP POLICY IF EXISTS "Master can view recalc queue"   ON public.score_recalc_queue;
CREATE POLICY "Master can view recalc queue"
  ON public.score_recalc_queue
  FOR SELECT
  USING (COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false));

DROP POLICY IF EXISTS "Staff can insert recalc queue"  ON public.score_recalc_queue;
DROP POLICY IF EXISTS "Master can insert recalc queue" ON public.score_recalc_queue;
CREATE POLICY "Master can insert recalc queue"
  ON public.score_recalc_queue
  FOR INSERT
  WITH CHECK (COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false));

-- ── visit_score_recalc_queue ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can view visit recalc queue"    ON public.visit_score_recalc_queue;
DROP POLICY IF EXISTS "Master can view visit recalc queue"   ON public.visit_score_recalc_queue;
CREATE POLICY "Master can view visit recalc queue"
  ON public.visit_score_recalc_queue
  FOR SELECT
  USING (COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false));

DROP POLICY IF EXISTS "Staff can insert visit recalc queue"  ON public.visit_score_recalc_queue;
DROP POLICY IF EXISTS "Master can insert visit recalc queue" ON public.visit_score_recalc_queue;
CREATE POLICY "Master can insert visit recalc queue"
  ON public.visit_score_recalc_queue
  FOR INSERT
  WITH CHECK (COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false));

COMMIT;
