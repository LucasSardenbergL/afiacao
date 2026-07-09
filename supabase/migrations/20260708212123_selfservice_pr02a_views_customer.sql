-- Self-service do comprador B2B — Fase 0 · PR0.2a — Views-gate customer-facing (leitura).
--
-- 3 views que expõem ao comprador APENAS o que é seguro, escopadas 100% no servidor pelo gate
-- do PR0.1 (`selfservice_conta_atual()`). `security_invoker=off` → a view lê a base como owner
-- (bypassa a RLS staff-only), e a PROJEÇÃO + o WHERE do gate são a barreira. Diferente das views
-- de reposição vazadas (chip P0): aqui há REVOKE anon + filtro por `habilitado ∧ account=ANY(accounts)`
-- ∧, no histórico, `customer_user_id=auth.uid()`. WHERE só comparações simples (poisoned-row → 0
-- linhas, nunca erro — Codex D2#7). `account = ANY(accounts)` NUNCA `COALESCE(...,true)` (D2#3).
--
-- NUNCA projetado: `omie_products.valor_unitario`/`estoque` (preço/estoque crus); `inventory_position.
-- saldo`/`cmc`/`preco_medio` (custo — só o booleano `disponivel`); `sales_orders.omie_payload`/
-- `omie_response` (JSON cru). Histórico exclui pedidos de uid staff (os 18 contaminados).
--
-- Preço fica FORA daqui (→ PR0.2b): a RPC de preço exige garantir que o número não rederiva o CMC.
--
-- Prova: db/test-selfservice-pr02a-views.sh (PG17: isolamento A×B + poisoned + falsificação).
-- ⚠️ Migração MANUAL — não auto-aplica no Lovable. Aplicar via SQL Editor (lovable-db-operator).

BEGIN;

-- Catálogo: nomes/família/conta. SEM valor_unitario cru, SEM estoque.
CREATE OR REPLACE VIEW public.selfservice_catalogo
  WITH (security_invoker=off, security_barrier=true) AS
  SELECT op.omie_codigo_produto, op.codigo, op.descricao, op.unidade,
         op.familia, op.subfamilia, op.account, op.imagem_url
  FROM public.omie_products op
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE
    AND op.ativo IS TRUE
    AND op.account = ANY(s.accounts);

-- Disponibilidade: booleano. NUNCA saldo/cmc/preco_medio (custo).
CREATE OR REPLACE VIEW public.selfservice_disponibilidade
  WITH (security_invoker=off, security_barrier=true) AS
  SELECT ip.omie_codigo_produto, ip.account, (ip.saldo > 0) AS disponivel
  FROM public.inventory_position ip
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE
    AND ip.account = ANY(s.accounts);

-- Meus pedidos (cabeçalho): SEM omie_payload/omie_response; exclui uids staff (os 18 contaminados).
-- Filtra TAMBÉM por account = ANY(accounts) (Codex PR0.2a#5): um pedido com customer_user_id=A mas
-- account de conta NÃO habilitada (colacor/multi-conta/legado) não pode vazar — a view roda como
-- owner (bypassa a RLS da base), então o gate de conta tem de estar no WHERE.
CREATE OR REPLACE VIEW public.selfservice_meus_pedidos
  WITH (security_invoker=off, security_barrier=true) AS
  SELECT so.id, so.omie_numero_pedido, so.account, so.status,
         so.created_at, so.order_date_kpi, so.total
  FROM public.sales_orders so
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE
    AND so.customer_user_id = (SELECT auth.uid())
    AND so.account = ANY(s.accounts)
    AND NOT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.user_id = so.customer_user_id AND p.is_employee IS TRUE);

-- Grants fail-closed explícitos (Codex PR0.2a#6): CREATE OR REPLACE VIEW preserva grants e REVOKE
-- só de anon não tira grants via PUBLIC/outros roles. Revoga de todos e concede SELECT só a authenticated.
REVOKE ALL ON public.selfservice_catalogo, public.selfservice_disponibilidade, public.selfservice_meus_pedidos
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.selfservice_catalogo, public.selfservice_disponibilidade, public.selfservice_meus_pedidos
  TO authenticated;

COMMIT;
