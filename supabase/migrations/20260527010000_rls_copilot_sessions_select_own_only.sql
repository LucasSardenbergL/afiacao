-- ============================================================
-- RLS: farmer_copilot_sessions SELECT → own-only (privacidade)
-- ============================================================
-- Follow-up de 20260526040000_rls_carteira_relacionamento_hardening.sql (que
-- endureceu as 5 tabelas de relacionamento da carteira). Decisão por codex
-- consult (2026-05-27): das 2 tabelas SENSÍVEIS, tratar diferente —
--
--   • farmer_calls: MANTER com cobertura. O Customer 360 lê calls por
--     customer_user_id (useCustomerCalls / customer360 hooks) → o dono precisa
--     ver o histórico COMPLETO de ligações do cliente, inclusive feitas por dono
--     anterior ou cobertura. Apertar quebraria a continuidade do 360 (histórico
--     vira parcial por vendedor). Continuidade do relacionamento > ganho marginal
--     de privacidade. (Não mexe aqui.)
--
--   • farmer_copilot_sessions: APERTAR pra own-only. É a sessão de TRABALHO do
--     vendedor com a IA copilot (raciocínio/notas/sugestões), NÃO histórico
--     institucional do cliente. Nenhum consumidor a lê por customer_user_id
--     (useFarmerPerformance e useCopilotEngine leem por farmer_id) → apertar NÃO
--     quebra nenhuma view, e fecha a leitura da sessão-de-trabalho de um vendedor
--     por outro (cobertura).
--
-- Só redefine a policy de SELECT (fcop_select_carteira): remove a 3ª cláusula
-- carteira_visivel_para(customer_user_id). INSERT/UPDATE/DELETE permanecem como a
-- migration anterior os deixou (pode_ver OR farmer_id=uid). service_role bypassa.
-- Idempotente (DROP IF EXISTS + CREATE). Depende da migration 20260526040000.

DROP POLICY IF EXISTS "fcop_select_carteira" ON public.farmer_copilot_sessions;
CREATE POLICY "fcop_select_carteira" ON public.farmer_copilot_sessions
  FOR SELECT TO authenticated
  USING (
    (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
    OR farmer_id = (SELECT auth.uid())
  );
