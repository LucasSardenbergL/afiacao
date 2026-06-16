-- 20260526060000_views_security_invoker_hardening.sql
-- ============================================================
-- Flip security_invoker=on em 3 views que rodavam com direitos do OWNER
-- (bypassando a RLS do usuário chamador). Follow-up do item 1 do
-- supabase/schema-security-report.md (P2 do codex no #246).
-- ============================================================
-- Achado: 3 das 37 views NÃO tinham WITH (security_invoker=on) → ao serem
-- consultadas via PostgREST por um usuário authenticated, rodavam com os
-- privilégios do owner e IGNORAVAM a RLS das tabelas-base. Um não-staff
-- (ex.: customer) podia bater direto em /rest/v1/<view> e ler dados que a
-- RLS das tabelas deveria bloquear.
--
-- Decisão (investigação caso-a-caso, como manda o schema-security-report):
--
--   1. score_recalc_pending / visit_score_recalc_pending
--      - Views triviais sobre score_recalc_queue / visit_score_recalc_queue
--        (filtram processed_at IS NULL).
--      - Bases têm RLS "Staff can view recalc queue" (master OR employee).
--      - Consumidores: SÓ edge functions (scoring-recalc-client/batch,
--        visit-score-recalc-client/batch) que rodam via service_role
--        (bypassa RLS → INALTERADAS). Zero consumidor frontend.
--      - Pós-flip: service_role intacto; staff direto ainda vê (RLS staff);
--        não-staff fica bloqueado (fecha o vazamento de customer_user_id/
--        farmer_id da fila). SEGURO, zero impacto de UI.
--
--   2. v_oportunidade_economica_hoje
--      - View de oportunidades comerciais por SKU (promoções + aumentos),
--        dado company-wide (NÃO per-cliente/PII).
--      - Cadeia: promocao_campanha + promocao_item (ambas "Staff vê") +
--        v_promocao_item_efetivo + v_sku_aumento_vigente +
--        v_sku_parametros_sugeridos (os 3 sub-views JÁ são security_invoker=on
--        e já consumidos por telas de staff hoje → cadeia provada staff-safe;
--        base sku_parametros = staff_sku_parametros_select).
--      - Consumidores (todos staff-gated): badge em AppShell
--        (enableReposicaoPolls = isStaff && !isSalesOnly), useReposicaoStatus
--        (cockpit), AdminReposicaoMercado. Todos com count filtrado por empresa.
--      - Pós-flip: chamador staff enxerga a cadeia inteira via "Staff vê" →
--        MESMO count (neutro pra staff); não-staff via PostgREST fica bloqueado
--        (fecha o vazamento da inteligência comercial). NEUTRO pra UI de staff.
--
-- Idempotente: ALTER VIEW ... SET (security_invoker = on) é re-rodável.
-- Reversível: ALTER VIEW ... SET (security_invoker = off) restaura o anterior
-- (caso algum count de staff mude inesperadamente — smoke-test no cockpit da
-- Reposição após aplicar).

ALTER VIEW public.score_recalc_pending          SET (security_invoker = on);
ALTER VIEW public.visit_score_recalc_pending    SET (security_invoker = on);
ALTER VIEW public.v_oportunidade_economica_hoje SET (security_invoker = on);

-- ============================================================
-- Validação
-- ============================================================
WITH v(name) AS (
  VALUES ('score_recalc_pending'),('visit_score_recalc_pending'),
         ('v_oportunidade_economica_hoje')
)
SELECT
  CASE WHEN (
    SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (SELECT name FROM v)
      AND (
        array_to_string(c.reloptions, ',') ILIKE '%security_invoker=on%'
        OR array_to_string(c.reloptions, ',') ILIKE '%security_invoker=true%'
      )
  ) = 3
  THEN '✅ 3 views agora com security_invoker=on (respeitam a RLS do chamador)'
  ELSE '❌ FALTANDO — confira reloptions das views abaixo' END AS status;
