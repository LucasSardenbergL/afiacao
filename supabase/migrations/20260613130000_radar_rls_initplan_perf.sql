-- =============================================================================
-- RADAR — FIX DE PERFORMANCE DA RLS (avaliação por-linha → InitPlan 1×)
-- Spec: docs/superpowers/specs/2026-06-10-radar-clientes-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable.
--
-- Bug (pego no smoke da Fatia 2): a policy de SELECT chamava
-- pode_ver_carteira_completa((SELECT auth.uid())) DIRETO no USING. Como a função
-- é SECURITY DEFINER, o planner NÃO a inlina e a avalia POR LINHA — sobre as 526k
-- linhas de radar_empresas (64k só de MG), cada avaliação faz 2 sub-queries
-- (has_role + get_commercial_role) → centenas de milhares de sub-queries →
-- estoura o tempo → timeout do PostgREST → o React Query re-tenta → a tela "fica
-- carregando" eternamente. (Com filtro seletivo tipo CNAE inexistente, 0 linhas
-- passam o índice antes da RLS → era rápido; por isso só MG/listas grandes travam.)
--
-- Fix: envolver a chamada num (SELECT ...) escalar → o Postgres a avalia 1× como
-- InitPlan (booleano constante), não por linha. Semântica IDÊNTICA (mesma função,
-- mesmo resultado) — só muda o plano de execução.
-- Provado em PG17 (250k linhas): 420ms (por-linha) → 12ms (InitPlan). 35×.
-- =============================================================================

DROP POLICY IF EXISTS "radar_empresas_select_gestor" ON public.radar_empresas;
CREATE POLICY "radar_empresas_select_gestor" ON public.radar_empresas
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS "radar_contatos_select_gestor" ON public.radar_contatos;
CREATE POLICY "radar_contatos_select_gestor" ON public.radar_contatos
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS "radar_municipios_select_gestor" ON public.radar_municipios;
CREATE POLICY "radar_municipios_select_gestor" ON public.radar_municipios
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS "radar_ingest_state_select_gestor" ON public.radar_ingest_state;
CREATE POLICY "radar_ingest_state_select_gestor" ON public.radar_ingest_state
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- Validação pós-apply (esperar policies_4 = 4)
SELECT 'RADAR RLS PERF OK' AS status,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
    AND tablename LIKE 'radar_%' AND policyname LIKE '%_select_gestor') AS policies_4;
