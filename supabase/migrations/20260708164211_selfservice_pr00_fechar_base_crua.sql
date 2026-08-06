-- Self-service do comprador B2B — Fase 0 · PR0.0 — Fechar a base crua `omie_products`.
--
-- VAZAMENTO PRÉ-EXISTENTE (P0): a policy "Authenticated users can view products" tinha
-- `USING (true)` → QUALQUER usuário autenticado (aprovado ou não, cliente de qualquer
-- empresa) lia o catálogo cru + `valor_unitario` + `estoque` das 3 contas via PostgREST.
-- É a fundação do self-service: a view-gate do PR0.2 (`selfservice_catalogo`) não protege
-- nada enquanto a tabela crua for legível — o cliente não é obrigado a usar a view.
--
-- FIX (mínimo, cirúrgico — Codex): basta REMOVER a policy `USING(true)`. A leitura de staff
-- continua pela policy "Staff can manage products" (FOR ALL, employee|master) que já existe e
-- cobre SELECT (policies permissivas do mesmo comando são OR). NÃO criamos uma policy SELECT
-- dedicada: seria redundante com a ALL (menos superfície permissiva = melhor). Sem nenhuma
-- policy SELECT permissiva para não-staff, a RLS nega → 0 linhas. `service_role` bypassa
-- (BYPASSRLS) → engines/edge/omie-sync intactos. O preflight de vendabilidade money-path
-- (`vendabilidade.ts`) roda como staff e continua enxergando `omie_products.ativo`.
--
-- FORA DESTE PR (achados do pré-voo — superfícies que leem omie_products como owner e que
-- esta policy NÃO cobre; tratar em PR próprio):
--   • `sales_orders.omie_payload/omie_response` acessíveis ao cliente (policy own) → PR0.0-bis
--     (canal staff SECDEF; sem custo/margem; P1 antes de self-service amplo).
--   • 5 views `security_invoker=off`/owner postgres com SELECT p/ anon (v_sku_candidatos_
--     primeira_compra, v_sku_demanda_*, v_sku_sigma_demanda, v_venda_items_history_efetivo)
--     e RPCs SECDEF sem gate (get_tint_price/get_tint_prices) → auditoria de bypass (PR à parte).
--
-- Prova: db/test-selfservice-pr00-base-crua.sh (PG17, SET ROLE + GUC + falsificação).
-- ⚠️ Migração MANUAL — não auto-aplica no Lovable. Aplicar via SQL Editor (lovable-db-operator).

BEGIN;

DROP POLICY IF EXISTS "Authenticated users can view products" ON public.omie_products;

COMMIT;
