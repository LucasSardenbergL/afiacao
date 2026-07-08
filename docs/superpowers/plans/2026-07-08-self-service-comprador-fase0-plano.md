# Self-service do comprador B2B — Fase 0 — Plano de Execução

> **Sub-skill de execução:** `superpowers:executing-plans` (checkpoints) ou `subagent-driven-development`. Steps em checkbox `- [ ]`.
> **Design + porquê (LER ANTES):** [2026-07-08-self-service-comprador-fase0.md](2026-07-08-self-service-comprador-fase0.md) — **§8 = v2 pós-Codex** (a fonte da verdade dos fixes).
> **Codex já rodou no DESIGN.** Rodar `/codex` (via `scripts/codex-async.sh -r xhigh`) de novo no **CÓDIGO** de cada PR money-path (PR0.0/0.1/0.2) antes de entregar — o design provado ≠ código provado.

**Goal:** entregar a fundação de autorização que permite expor a maquinaria de e-commerce ao comprador de produto — base crua fechada, allowlist fail-closed, superfícies customer-facing escopadas por `auth.uid()`, tudo provado adversarialmente.

**Architecture:** 4 PRs sequenciais. PR0.0 fecha o que já vaza (base crua). PR0.1 monta o gate (allowlist + RPC). PR0.2 monta as superfícies de leitura (views-gate). PR0.3 prova isolamento adversarial. Nenhuma tela nova de compra — só a fundação.

**Tech Stack:** Postgres (Supabase), RLS, views `security_invoker=off`, RPC `SECURITY DEFINER`, PG17 local (`prove-sql-money-path`), migration manual (`lovable-db-operator`).

## Global Constraints (repo + Codex — valem em TODA task)
- **Migration custom NÃO auto-aplica no Lovable** → sempre `lovable-db-operator` (bloco SQL Editor + query de validação pós-apply + `bun run audit:migrations`). Nunca tocar `supabase/migrations/` a não ser criar o `.sql` novo.
- **Money-path/auth → `prove-sql-money-path` (PG17) ANTES de entregar:** aplica a migration REAL, semeia, asserts positivos **E** negativos (SQLSTATE + re-raise, nunca `WHEN OTHERS THEN 'OK'`), e **falsifica** (sabota a migration → exige vermelho). plpgsql é late-bound (CREATE passa com SQL inválido).
- **Isolamento/RLS → provar sob `SET ROLE authenticated` + `SET request.jwt.claims`** (psql-ro tem BYPASSRLS e NÃO reproduz RLS).
- **Prova de vazamento inclui REST/embed direto**, não só SQL — o cliente não é obrigado a usar a view (achado Codex P0#3).
- **Toda RPC nova:** `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon` + `GRANT EXECUTE … TO authenticated` mínimo; pós-apply provar `has_function_privilege('anon', …)=false` (`database.md §59`).
- **Policies/WHERE InitPlan-wrapped:** `(SELECT auth.uid())`, `(SELECT fn(...))` — senão reavalia por linha e estoura `statement_timeout` (`database.md §4`).
- **Gate customer canônico:** `is_employee IS FALSE` **AND** `is_approved` **AND** flag global **AND** `allowlist.enabled` — **fail-closed** (default nega).
- **Tabela nova sempre RLS + REVOKE nominal `anon`** (REVOKE FROM PUBLIC não tira anon/authenticated).
- **Pré-flight de schema:** antes de cada `CREATE OR REPLACE`/`ALTER`, conferir prod via `psql-ro` (`pg_get_viewdef`/`pg_get_functiondef`/`pg_indexes`+`pg_constraint`) — apply manual diverge do repo; a última a recriar vence.

---

## PR0.0 — Fechar a base crua (o que JÁ vaza) 🟥

**Files:**
- Create: `supabase/migrations/20260708HHMMSS_selfservice_pr00_fechar_base_crua.sql`
- Create (prova): `db/test-selfservice-pr00-base-crua.sh` (via skill `prove-sql-money-path`)
- Ref: consumidores de `omie_products` (grep em §8.3 do design)

**Por quê primeiro (Codex P0#1):** a view-gate do PR0.2 não protege nada se `omie_products` (`USING(true)`) segue acessível cru via PostgREST (o cliente não é obrigado a usar a view). O caso `sales_orders`/`omie_payload` (P0#3) foi **reclassificado → PR0.0-bis** após o pré-flight (Step 1-bis: staff lê+escreve via `authenticated`; payload sem custo/margem).

**✅ EXECUTADO (2026-07-08):** migration `20260708164211_selfservice_pr00_fechar_base_crua.sql` — **só o DROP** da policy `USING(true)` (Codex acatou a simplificação: staff lê pela policy `ALL` existente, sem criar policy SELECT redundante). Prova `db/test-selfservice-pr00-base-crua.sh` **VERDE 13/13** (SET ROLE + GUC + falsificação com dente, incl. embed/join). Codex gpt-5.5 xhigh incorporado. **Achados do pré-voo escalados (fora do escopo do PR0.0):** (a) 5 views `security_invoker=off` anon-readable que vazam custo/demanda/vendas → chip `task_0beb0615`; (b) `omie_payload`/`omie_response` → PR0.0-bis, classificado **P1 obrigatório antes de self-service amplo** (Codex); (c) RPCs SECDEF `get_tint_price/get_tint_prices` sem gate staff → auditar no chip.

- [x] **Step 1 — Pré-flight bloqueante (grep + rota):** ✅ 25 leituras de `omie_products` em `src/`, TODAS staff-gated. Confirmados: `SalesProducts.tsx:41-45` (redireciona não-staff), `useProductCatalog` `enabled: isStaff` (`useUnifiedOrder.ts:342`), `vendabilidade.ts:66` recebe só `[...obenProductItems,...colacorProductItems]` (`submitOrder.ts:131`; afiação NÃO entra → carrinho de cliente = array vazio = early-return `ok` em `vendabilidade.ts:56`, nunca toca a tabela; caso-borda = `.in()` vazio/negado → `itensNaoVendaveis` marca tudo inativo → **fail-closed bloqueia**). Demais: tint*/reposição*/admin/salesOrderEdit/knowledge-base/engines de venda assistida. **Zero consumidor em rota não-staff.**
- [x] **Step 1-bis — Leitores de `omie_payload`/`omie_response` (grep):** 🔴 staff LÊ e ESCREVE via PostgREST autenticado: `useSalesOrderEdit.ts:69` (SELECT) + `:257,319` (UPDATE), `SalesPrintDashboard.tsx:202,291`, `salesOrders/print.ts:52`, `sales/print/buildPrintHtml.ts:34`. → `REVOKE SELECT(col) FROM authenticated` é global por-role e QUEBRARIA o staff. **3b movido → PR0.0-bis.**
- [x] **Step 2 — Pré-flight schema (psql-ro):** ✅ `omie_products` policy `"Authenticated users can view products"` SELECT `qual=true` p/ authenticated (o vazamento) + `"Staff can manage products"` ALL. `sales_orders`/`order_items`: policy "own" (`auth.uid()=customer_user_id`) + staff ALL. `has_column_privilege(authenticated,sales_orders,omie_payload/omie_response,SELECT)=true`. `omie_payload` keys=`cabecalho,det,frete,informacoes_adicionais,observacoes`; **0 ocorrências de cmc/custo/margem/markup** em 1000 pedidos → sem vazamento de custo (pedido do PRÓPRIO cliente).
- [ ] **Step 3 — Escrever a migration (SÓ `omie_products`):**
```sql
BEGIN;
-- omie_products: fechar leitura crua a não-staff (customer usará selfservice_catalogo no PR0.2).
DROP POLICY IF EXISTS "Authenticated users can view products" ON public.omie_products;
CREATE POLICY "omie_products_select_staff" ON public.omie_products
  FOR SELECT TO authenticated
  USING ((SELECT (has_role((SELECT auth.uid()),'employee'::app_role)
               OR has_role((SELECT auth.uid()),'master'::app_role))));
-- service_role bypassa via BYPASSRLS (engines/edge intactos).
-- "Staff can manage products" (ALL) já existe → staff mantém SELECT/IUD.
COMMIT;
```
  ⚠️ **`omie_payload`/`omie_response` NÃO entram aqui (→ PR0.0-bis).** Step 1-bis provou consumidor staff via `authenticated`; REVOKE column-level é global por-role → quebraria edição/impressão staff. Payload sem custo/margem (Step 2). Fechar direito = canal staff SECDEF (refactor) = PR próprio. A view `selfservice_meus_pedidos` (PR0.2) já não projeta essas colunas → a superfície self-service não as expõe.
- [ ] **Step 4 — Prova PG17 (`prove-sql-money-path`):** semear `omie_products` (2 accounts, ativo+inativo). Sob `SET ROLE authenticated` + GUC de cliente comum (sem role staff): `SELECT * FROM omie_products` → **0 linhas**. Sob GUC de staff (`user_roles` employee) → vê o catálogo. **Falsificar:** recriar a policy como `USING(true)` → o assert de 0-linhas do cliente deve ficar VERMELHO.
- [ ] **Step 5 — Prova de embed/PostgREST (Codex P0#3):** no harness, cliente comum `SELECT valor_unitario, estoque FROM omie_products` → 0 linhas; embed a partir de tabela relacionada (`order_items → omie_products`) não retorna colunas do produto. Sanidade REST direta documentada no PR.
- [ ] **Step 6 — Empacotar (`lovable-db-operator`):** bloco SQL Editor + validação pós-apply ESTRUTURAL (`SELECT policyname, cmd, qual FROM pg_policies WHERE tablename='omie_products' ORDER BY 1;` → a antiga `"Authenticated users can view products"` sumiu; nova `omie_products_select_staff` com `qual`=has_role staff) + nota "⚠️ migration manual (não auto-aplica)" + `bun run audit:migrations`. (RLS COMPORTAMENTAL prova-se no Step 4/PG17 — o SQL Editor roda como `postgres`/BYPASSRLS.)
- [ ] **Step 7 — Codex challenge no CÓDIGO** da migration (via `codex-async.sh -r xhigh`) antes de entregar. Incorporar. Commit + PR (draft até prova verde).

---

## PR0.0-bis — Fechar `omie_payload`/`omie_response` ao cliente (canal staff SECDEF) 🟧

**Origem:** Step 1-bis do PR0.0 provou que o REVOKE column-level não é aplicável direto (staff LÊ+ESCREVE via `authenticated`; grant não distingue `has_role`). Separado para **não travar a fundação** e porque **não é a mesma severidade** do `omie_products`: o cliente só vê o payload do PRÓPRIO pedido (policy "own", row-level) e ele **não contém custo/margem** (Step 2: 0 ocorrências de cmc/custo/margem/markup; keys = cabecalho/det/frete/informacoes_adicionais/observacoes).

**Files:**
- Create: `supabase/migrations/…_selfservice_pr00bis_omie_payload_staff.sql`
- Modify: `src/components/salesOrderEdit/useSalesOrderEdit.ts` (SELECT+UPDATE de `omie_payload` → RPC), `src/pages/SalesPrintDashboard.tsx`, `src/components/salesOrders/print.ts`, `src/components/sales/print/buildPrintHtml.ts`
- Create (prova): `db/test-selfservice-pr00bis-payload.sh`

**Esboço:**
- RPC SECDEF `staff_get_sales_order_payload(p_order_ids uuid[]) RETURNS TABLE(id uuid, omie_payload jsonb, omie_response jsonb)`, gate `has_role(employee|master)`, `REVOKE…FROM PUBLIC,anon,authenticated` + `GRANT EXECUTE` mínimo — leitura em lote p/ o dashboard.
- RPC SECDEF `staff_update_sales_order_payload(p_id uuid, p_payload jsonb)` p/ o writer da edição.
- Só DEPOIS de migrar os 4 leitores + 1 writer: `REVOKE SELECT (omie_payload, omie_response) ON public.sales_orders FROM authenticated;` (+ `REVOKE UPDATE(...)`). Prova PG17: cliente `SELECT omie_payload` do próprio pedido → 42501; staff via RPC → ok. Prova REST/embed. Falsificar.

**Decisão a validar no Codex:** aceitar como dívida priorizada (a fundação PR0.2 já não expõe payload) OU antecipar. Enquanto não fecha: risco residual DOCUMENTADO = cliente lê JSON do próprio pedido (sem custo/margem).

---

## PR0.1 — Allowlist + gate de elegibilidade 🟥

**Files:**
- Create: `supabase/migrations/20260708HHMMSS_selfservice_pr01_allowlist_gate.sql`
- Create (prova): `db/test-selfservice-pr01-gate.sh`
- Create (front): `src/hooks/useSelfServiceStatus.ts`, `src/components/RequireSelfService.tsx`
- Ref (molde): `supabase/migrations/20260704120000_preco_por_tier.sql:30-97`

**Interfaces produzidas (consumidas por PR0.2/0.3):**
- `selfservice_conta_atual() → TABLE(customer_user_id uuid, accounts text[], habilitado boolean)` — o gate canônico.

- [ ] **Step 1 — Pré-flight:** confirmar `company_config` (key/value), `has_role`, `pode_ver_carteira_completa(uuid)` via psql-ro (assinaturas já vistas). Confirmar valor da flag ausente hoje (→ default false).
- [ ] **Step 2 — Migration (allowlist + trigger anti-forje + gate):**
```sql
BEGIN;
-- Allowlist: enabled DEFAULT FALSE (Codex P1#4), cliente SEM IUD.
CREATE TABLE IF NOT EXISTS public.selfservice_cliente_allowlist (
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account text NOT NULL CHECK (account IN ('oben','colacor','colacor_sc')),
  enabled boolean NOT NULL DEFAULT false,
  enabled_by uuid REFERENCES auth.users(id),
  enabled_at timestamptz,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_user_id, account)
);
CREATE INDEX IF NOT EXISTS idx_ss_allowlist_customer ON public.selfservice_cliente_allowlist(customer_user_id);

-- anti-forje: enabled_by/enabled_at forçados quando enabled vira true
CREATE OR REPLACE FUNCTION public.ss_allowlist_forca_autor()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.enabled IS TRUE AND (TG_OP='INSERT' OR OLD.enabled IS DISTINCT FROM true) THEN
    IF auth.uid() IS NOT NULL THEN NEW.enabled_by := auth.uid(); END IF;
    NEW.enabled_at := now();
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_ss_allowlist_autor ON public.selfservice_cliente_allowlist;
CREATE TRIGGER trg_ss_allowlist_autor BEFORE INSERT OR UPDATE ON public.selfservice_cliente_allowlist
  FOR EACH ROW EXECUTE FUNCTION public.ss_allowlist_forca_autor();

ALTER TABLE public.selfservice_cliente_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.selfservice_cliente_allowlist FROM anon;
-- cliente lê SÓ a própria linha (read-only); gestor gerencia; SEM IUD de cliente
CREATE POLICY ss_allowlist_customer_select ON public.selfservice_cliente_allowlist
  FOR SELECT TO authenticated USING (customer_user_id = (SELECT auth.uid()));
CREATE POLICY ss_allowlist_staff_select ON public.selfservice_cliente_allowlist
  FOR SELECT TO authenticated USING ((SELECT (has_role((SELECT auth.uid()),'employee'::app_role) OR has_role((SELECT auth.uid()),'master'::app_role))));
CREATE POLICY ss_allowlist_gestor_iud ON public.selfservice_cliente_allowlist
  FOR ALL TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
CREATE POLICY ss_allowlist_service ON public.selfservice_cliente_allowlist
  FOR ALL USING (auth.role()='service_role');

-- Gate canônico: fail-closed, exige is_employee=false (Codex P0#2)
CREATE OR REPLACE FUNCTION public.selfservice_conta_atual()
RETURNS TABLE(customer_user_id uuid, accounts text[], habilitado boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT (SELECT auth.uid()),
    COALESCE((SELECT array_agg(DISTINCT a.account)
              FROM public.selfservice_cliente_allowlist a
              WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE), '{}'::text[]),
    ( COALESCE((SELECT (value)::boolean FROM public.company_config WHERE key='selfservice_produto_enabled'), false)
      AND COALESCE((SELECT p.is_approved FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      AND COALESCE((SELECT p.is_employee IS FALSE FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      AND EXISTS (SELECT 1 FROM public.selfservice_cliente_allowlist a
                  WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE) );
$$;
REVOKE ALL ON FUNCTION public.selfservice_conta_atual() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.selfservice_conta_atual() TO authenticated;

INSERT INTO public.company_config(key, value) VALUES ('selfservice_produto_enabled','false')
  ON CONFLICT (key) DO NOTHING;   -- flag nasce DESLIGADA
COMMIT;
```
- [ ] **Step 3 — Prova PG17:** cenários sob `SET ROLE authenticated` + GUC:
  - Cliente aprovado + allowlisted(enabled) + flag ON + is_employee=false → `habilitado=true`, accounts corretos.
  - Cada default OFF isolado (flag off / not approved / is_employee=true / sem linha / enabled=false) → `habilitado=false`. (um assert por default, doc×código).
  - Cliente NÃO consegue INSERT/UPDATE na allowlist (RLS nega IUD).
  - `has_function_privilege('anon','selfservice_conta_atual()','EXECUTE')` = **false**.
  - **Falsificar:** trocar `enabled DEFAULT false`→`true` OU remover o `is_employee IS FALSE` → assert de default-fechado VERMELHO.
- [ ] **Step 4 — Front:** `useSelfServiceStatus` (react-query sobre `selfservice_conta_atual`), `RequireSelfService` (fail-closed, molde `RequireStaff`). Nenhuma rota nova de compra ainda — só o gate disponível.
- [ ] **Step 5 — Codex challenge no código + empacotar (`lovable-db-operator`) + PR draft.**

---

## PR0.2 — Superfícies de leitura customer-facing (views-gate + RPC preço) 🟥

**Files:**
- Create: `supabase/migrations/20260708HHMMSS_selfservice_pr02_views_customer.sql`
- Create (prova): `db/test-selfservice-pr02-views.sh`

**Consome:** `selfservice_conta_atual()` (PR0.1). **Só entrar após PR0.0 (base fechada).**

- [ ] **Step 1 — Views-gate** (`security_invoker=off, security_barrier=true`; WHERE só comparações simples — Codex P1#7; sem `selfservice_meu_tier` — P1#6):
```sql
BEGIN;
-- Catálogo: SEM valor_unitario cru, SEM estoque
CREATE OR REPLACE VIEW public.selfservice_catalogo
  WITH (security_invoker=off, security_barrier=true) AS
  SELECT op.omie_codigo_produto, op.codigo, op.descricao, op.unidade,
         op.familia, op.subfamilia, op.account, op.imagem_url
  FROM public.omie_products op
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE AND op.ativo IS TRUE AND op.account = ANY(s.accounts);

-- Disponibilidade: booleano, NUNCA saldo/cmc/preco_medio
CREATE OR REPLACE VIEW public.selfservice_disponibilidade
  WITH (security_invoker=off, security_barrier=true) AS
  SELECT ip.omie_codigo_produto, ip.account, (ip.saldo > 0) AS disponivel
  FROM public.inventory_position ip
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE AND ip.account = ANY(s.accounts);

-- Meus pedidos (cabeçalho): SEM omie_payload/omie_response; exclui uids staff (os 18)
CREATE OR REPLACE VIEW public.selfservice_meus_pedidos
  WITH (security_invoker=off, security_barrier=true) AS
  SELECT so.id, so.omie_numero_pedido, so.account, so.status,
         so.created_at, so.order_date_kpi, so.total
  FROM public.sales_orders so
  CROSS JOIN LATERAL (SELECT habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE
    AND so.customer_user_id = (SELECT auth.uid())
    AND NOT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.user_id = so.customer_user_id AND p.is_employee IS TRUE);

REVOKE ALL ON public.selfservice_catalogo, public.selfservice_disponibilidade, public.selfservice_meus_pedidos FROM anon;
GRANT SELECT ON public.selfservice_catalogo, public.selfservice_disponibilidade, public.selfservice_meus_pedidos TO authenticated;
COMMIT;
```
- [ ] **Step 2 — RPC de preço (número final só — Codex P1#6):** `selfservice_preco_produto(p_omie_codigo bigint, p_account text) RETURNS numeric`, SECDEF, gate `habilitado ∧ p_account=ANY(accounts)`, retorna **preço de tabela ajustado ao tier do PRÓPRIO cliente** (reusa `resolve_markup_policy` do próprio, **sem** o leave-one-out cross-cliente de `get_regua_preco`), **sem** piso/reason/tier. `NULL` fail-closed (degradação honesta, não fabrica). REVOKE PUBLIC,anon + GRANT authenticated. ⚠️ **decisão money-path a challengar no Codex-código:** garantir que o preço retornado não seja função direta de `cmc` (não rederivar custo).
- [ ] **Step 3 — Prova PG17 + REST/embed:** semear cliente A (oben) e B (colacor), allowlist só A(oben). Sob GUC de A:
  - `selfservice_catalogo` → só produtos de `oben`; **zero** de colacor.
  - `selfservice_disponibilidade` → só booleano; provar que `saldo`/`cmc` **não** são projetáveis (coluna inexistente na view).
  - `selfservice_meus_pedidos` → só pedidos de A; **embed** `?select=*,omie_products(valor_unitario)` → negado (PR0.0 fechou a base).
  - `selfservice_preco_produto(sku_de_colacor,'colacor')` sob A → **NULL** (fora da allowlist).
  - **Poisoned row** (Codex P1#7): linha de B com JSON/cast quebrado → view de A retorna **0 linhas, nunca erro**.
  - **Falsificar:** trocar `account = ANY(s.accounts)` por `COALESCE(...,true)` → A passa a ver colacor → VERMELHO.
- [ ] **Step 4 — Codex challenge no código (foco: preço não-rederiva-cmc, WHERE não-leaky) + empacotar + PR draft.**

---

## PR0.3 — Smoke adversarial de isolamento 🟥

**Files:**
- Create: `db/test-selfservice-pr03-isolamento.sh` (PG17, SET ROLE + GUC)
- Create (estrutural): assert `pg_get_viewdef` anti-`documento`

**É o teste-síntese.** Semeadura única: cliente **A** (uid_a, account `oben`, doc `D_A`), cliente **B** (uid_b, account `colacor`, doc `D_B`), grupo econômico **G** = {D_A, D_C'} (C' outro CNPJ), staff **S** (com 1 dos 18 pedidos sob seu uid). Allowlist: só A(oben) enabled.

- [ ] **Step 1 — Matriz de isolamento** (cada um sob GUC de A, esperado **negado/0**):
  - preço/catálogo/disponibilidade/pedido/histórico de **B** → 0.
  - dados do CNPJ irmão **C'** do grupo G → 0 (não há caminho `auth.uid()→documento→grupo`).
  - qualquer `account` fora de {oben} → 0.
  - `omie_products` cru / `omie_payload` de sales_orders → negado (regressão do PR0.0).
  - `get_regua_preco`/edge `recommend` chamados por A → **rejeitados** (staff-only preservado).
- [ ] **Step 2 — Contaminação staff:** allowlistar **S** por engano + flag ON → `selfservice_conta_atual()` de S = `habilitado=false` (is_employee=true) → S **não** vê os pedidos-fantasma dos clientes. Assert explícito.
- [ ] **Step 3 — Teste estrutural anti-documento:** para cada view `selfservice_*`, `pg_get_viewdef` **NÃO** pode conter `document`, `cnpj`, `cliente_grupo`. Assert falha se algum futuro PR reintroduzir doc.
- [ ] **Step 4 — Default privileges:** `has_function_privilege('anon', …)` = false para todas as RPCs novas; `has_table_privilege('anon', 'selfservice_*', 'SELECT')` = false.
- [ ] **Step 5 — Falsificação global:** sabotar UMA barreira por vez (remover `is_employee` do gate; `COALESCE(...,true)` no account; re-`USING(true)` em omie_products) → o smoke correspondente fica VERMELHO. Prova que os asserts têm dente.
- [ ] **Step 6 — Codex review final do smoke + registrar em `docs/historico/`.**

---

## Dependências
PR0.0 → PR0.1 → PR0.2 → PR0.3. Cada PR: prove-sql verde + falsificação + Codex-código + `lovable-db-operator` (founder aplica) + verificação pós-apply antes do próximo.

## Fora do escopo (dívida referenciada)
- Backfill de `customer_document` + fix do `customerUserId || user.id` (`submitOrder.ts:171,284`, `submitQuote.ts:58,106`) — programa à parte; enquanto isso os 18 ficam em quarentena pela exclusão de uids staff.
- Telas de compra (catálogo/carrinho/cotação do comprador) = Fases 1+.
- UI de admin da allowlist (staff liga/desliga cliente) — mínima no PR0.1 (ou logo após); rollout começa com 1 cliente aprovado.
