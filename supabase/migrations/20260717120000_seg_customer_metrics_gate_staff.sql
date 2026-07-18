-- ============================================================
-- 20260717120000_seg_customer_metrics_gate_staff.sql
-- Segurança — fecha a exposição de public.customer_metrics_mv a QUALQUER
-- `authenticated` (inclusive customer). [money-path: autorização]
--
-- ACHADO (catálogo prod 2026-07-17 + prova PG17 db/test-customer-metrics-viewgate.sh):
--   A view public.customer_metrics_mv é `security_invoker=off` (lê a MV em
--   `private` como OWNER, contornando a ausência de grant) e tem
--   `GRANT SELECT TO authenticated` — mas NENHUM gate no WHERE. Como customer e
--   staff compartilham o role `authenticated`, qualquer JWT de customer fazia
--   `GET /rest/v1/customer_metrics_mv` e recebia razão social, documento,
--   faturamento e ticket médio de TODOS os clientes.
--
-- NÃO é regressão do invoker (#1375/#1377) e não há grant `anon`: é dívida
-- PRÉ-EXISTENTE e deliberada. O `20260629120000_seg_customer_metrics_viewgate`
-- moveu a MV p/ `private` para calar o lint "Materialized View in API"
-- ("SEM mudar comportamento nem o frontend", diz o cabeçalho) e PRESERVOU a
-- exposição: assumiu `authenticated` == staff. A MV nunca teve RLS.
--
-- POR QUE NÃO `security_invoker=on`: `authenticated` não tem grant na MV em
-- `private` (REVOKE ALL, por design) ⇒ ligar o invoker daria 42501 para TODO
-- mundo, inclusive o staff, quebrando as telas. O padrão do repo para este caso
-- é o do `v_oportunidade_economica_hoje_badge_cached` (docs/agent/database.md):
-- manter `invoker=off` + `barrier=true` e replicar a autz num VIEW-GATE no WHERE.
--
-- AUTORIZAÇÃO REPLICADA: staff (employee|master) + service_role. Sem ramo
-- own-scope — nenhum consumidor é tela de customer (verificado): as 3 telas
-- (Customer360, MeuDia/Fila, Rota) estão sob <RequireStaff> em src/App.tsx e a
-- edge ai-ops-agent lê com client SERVICE_ROLE_KEY. A RPC get_customer_metrics
-- (SELECT * FROM public.customer_metrics_mv) não tem grant p/ `authenticated`
-- e não é chamada por ninguém — herda o gate sem quebrar nada.
--
-- ⚠️ O `WITH (...)` é REPETIDO no replace de propósito: omiti-lo RESETA as
-- opções e a view volta a ler como owner sem gate — falha ABERTA (#1375/#1377).
-- A lista/ordem de colunas é IDÊNTICA (só acrescenta WHERE) ⇒ replace seguro.
-- Idempotente. Transacional.
-- ============================================================
BEGIN;

CREATE OR REPLACE VIEW public.customer_metrics_mv
  WITH (security_invoker = off, security_barrier = true) AS
  SELECT customer_user_id,
         razao_social,
         document,
         ultima_compra_data,
         dias_desde_ultima_compra,
         pedidos_90d,
         faturamento_90d,
         ticket_medio_90d,
         faturamento_prev_90d,
         intervalo_medio_dias,
         atraso_relativo,
         is_cold_start,
         calculated_at
    FROM private.customer_metrics_mv
   WHERE (SELECT auth.role()) = 'service_role'
      OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::app_role)), false)
      OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'employee'::app_role)), false);

-- Grants verbatim do estado atual (o gate filtra; o grant continua necessário —
-- o disjunct `service_role` é inútil sem o GRANT correspondente).
REVOKE ALL ON public.customer_metrics_mv FROM anon;
GRANT SELECT ON public.customer_metrics_mv TO authenticated, service_role;

COMMIT;
