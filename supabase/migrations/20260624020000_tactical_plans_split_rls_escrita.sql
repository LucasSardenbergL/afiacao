-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ farmer_tactical_plans — split da RLS: fecha a escrita DIRETA do client       ║
-- ║ [autz / money-path] — PR2, fronteira do #1037 (RPCs de escrita)              ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
-- O #1037 criou as RPCs criar_plano_tatico / registrar_resultado_plano (SECURITY
-- DEFINER: posse re-resolvida server-side + gate carteira_visivel_para) e portou a
-- edge. MAS a policy "Staff can manage tactical plans" (FOR ALL, master OR employee)
-- ainda dava ao client a ESCRITA DIRETA via PostgREST — então as RPCs eram
-- opcionais, não a fronteira (BFLA — database.md §4: FOR ALL amplo = qualquer staff
-- gerencia tudo). Este split torna as RPCs a ÚNICA porta de escrita do client:
--   • leitura staff (master OR employee) PRESERVADA — o escopo por dono/cobertura é
--     app-side (#1028: a RLS desta tabela é staff-amplo de propósito);
--   • SEM policy INSERT/UPDATE/DELETE → escrita direta de `authenticated` NEGADA
--     (INSERT → 42501; UPDATE/DELETE → 0 linhas, RLS filtra a linha como invisível);
--   • service_role (rolbypassrls=t, confirmado psql-ro) e as RPCs (DEFINER, owned by
--     postgres) seguem escrevendo — engines/cron intactos.
--
-- ⚠️ ORDEM DE APLICAÇÃO: aplicar SÓ depois do client portado estar em prod
--    (generatePlan/recordResult via supabase.rpc, neste mesmo PR). Aplicar ANTES
--    quebraria a escrita do client atual (que ainda faz insert/update direto).
--    Sequência do founder: Publish (frontend portado) → ENTÃO este SQL.
-- ⚠️ Provada localmente: db/test-tactical-plans-rls-split.sh (PG17 + falsificação).

-- Remove a policy ALL (escrita direta staff-vê-tudo) e instala só a leitura.
DROP POLICY IF EXISTS "Staff can manage tactical plans" ON public.farmer_tactical_plans;

DROP POLICY IF EXISTS "tactical_plans_select_staff" ON public.farmer_tactical_plans;
CREATE POLICY "tactical_plans_select_staff"
  ON public.farmer_tactical_plans
  FOR SELECT
  USING (
    has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)
  );

-- (sem policy de INSERT/UPDATE/DELETE — escrita direta de authenticated fica negada;
--  toda escrita passa pelas RPCs SECURITY DEFINER ou por service_role/bypassrls.)
