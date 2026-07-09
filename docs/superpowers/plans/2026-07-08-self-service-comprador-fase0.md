# Self-service do comprador B2B — Fase 0 (fundação de autorização) — DESIGN

> **Status:** v2 PÓS-Codex (gpt-5.5 xhigh, 2026-07-08) — parecer INCORPORADO em **§8** (10 achados, convergência total; deltas + reordenação: hardening da base crua vira **PR0.0**). **Ler §8 antes de qualquer SQL/tela.** Próximo: `writing-plans` (plano executável) a partir de §8.
> **Origem:** `docs/superpowers/specs/2026-07-07-self-service-comprador-b2b-programa.md` (Fase 0). Evidência revalidada 2026-07-08 (main em `6bde622b`, = a própria spec; 0 drift de conteúdo, 2 drifts de path anotados).
> **Escopo:** SÓ a fundação. Nenhuma tela de compra nova, nenhum "pedido direto". Entrega a camada de autorização sobre a qual as Fases 1+ plugam.

## 0. Achados que orientam o design (evidência real)

### Modelo de identidade (banco vivo, via psql-ro)
- **Não existe entidade "cliente" com join `user↔cliente`. Um cliente É um `auth.users`.** A coluna de escopo é `customer_user_id` (uuid) — em `sales_orders`, `cliente_tier_preco`, `carteira_assignments`. Não há `cliente_id` em lugar nenhum. Não existe `fn_cliente_atual()` (greenfield).
- **Empresa = `account` (texto, sem FK, sem RLS):** `oben`/`colacor`/`colacor_sc`. Em `sales_orders.account`, `inventory_position.account`, `omie_products.account`. Em preço/tier a coluna é `company`; em omie é `empresa_omie`.
- **`profiles`:** `user_id`→auth, `document`, `cnpj`, `is_employee`, `is_approved`, `requires_po`. Cliente = `is_employee=false`.
- **Grupo econômico:** `cliente_grupos`+`cliente_grupo_membros(grupo_id, documento)`. Liga por **CNPJ/CPF** (`UNIQUE(documento)`), gate `fin_user_can_access()` (staff). Sem caminho customer-facing.

### Números que decidiram trade-offs (psql-ro, 2026-07-08)
| Fato | Número | Decisão que trava |
|---|---|---|
| Pedidos totais | 29.792 | — |
| Pedidos com `customer_user_id` de staff (contaminação `customerUserId \|\| user.id`) | **18 (0,06%)** | D5: âncora `customer_user_id` é limpa o bastante; 18 = dívida |
| Pedidos com `customer_document` preenchido | **0 (0%)** | D5: NÃO dá p/ ancorar em documento (coluna nunca backfilled) |
| Clientes aprovados (is_employee=f, is_approved=t) | **1** | rollout começa minúsculo; allowlist trivial |
| Clientes em `omie_clientes` por empresa | **6.909, todos `colacor`** | D3: NÃO derivar loja de `empresa_omie`; allowlist carrega `account` |

### RLS/autz atual das tabelas-núcleo (psql-ro)
- **`sales_orders`:** ✅ já tem `Customers can view their own sales orders` SELECT `USING (auth.uid()=customer_user_id)`. Idem `order_items`, `sales_price_history`. **Autz de pedido já pronta.**
- **`cliente_tier_preco`:** 🔴 SELECT **staff-only** (`employee|master`). Cliente não vê o próprio preço.
- **`inventory_position`:** 🔴 SELECT **staff-only**. E a linha carrega `cmc`+`preco_medio` (**custo** — nunca expor).
- **`omie_products`:** 🔴🔴 `SELECT USING(true)` p/ `authenticated` — **qualquer autenticado lê catálogo+`valor_unitario`+`estoque` das 3 empresas**. Vazamento pré-existente (P0).
- **`get_regua_preco` (RPC preço):** SECDEF **staff-only** (`RAISE 'forbidden'`), usa comparáveis **cross-cliente** (leave-one-out `oi.customer_user_id <> p_customer`). Inservível ao cliente.

### Gates de UX ≠ autz (confirmado)
`RequireStaff` usa `useDisplayAccess().displayIsStaff` (comentado: "NUNCA usar p/ decidir escrita/identidade"). `isCustomerMode = !isStaff` (branch de fluxo). Feature flags = **localStorage client-only** (`useFeatureFlag.ts`), imprestável como gate. `company_config` (key/value server-side) é **staff-only** — cliente não lê. **Não existe `RequireFeature`.**

### Tese (explorador de maquinaria)
O padrão dominante é *"o client passa `customer_user_id`/`account`/`p_customer` como parâmetro e confia na RLS/edge-gate"*. Para o comprador, o filtro-cliente precisa **migrar da camada React para o servidor** (view/RPC que derive de `auth.uid()`). É exatamente esta Fase 0.

---

## 1. Modelo de autorização proposto (a fronteira real)

**Âncora única e inegociável:** todo dado customer-facing escopa por **`customer_user_id = (SELECT auth.uid())`** e por **`account ∈ allowlist(auth.uid())`**. Nunca por `documento`/CNPJ (dado público — foi o vetor do privilege-escalation do `auto_assign_user_role`, `database.md §4`). Nunca por `account`/`company` vindo de parâmetro/URL/localStorage.

**Três camadas:**
1. **Gate de elegibilidade** (PR0.1): flag global × allowlist por (cliente, account) × `is_approved`. Resolvido 100% no servidor, fail-closed.
2. **Superfície de leitura** (PR0.2): views/RPCs dedicadas que expõem **só colunas seguras**, escopadas pela âncora. Nunca reusar query/RPC staff.
3. **Prova** (PR0.3): PG17 sob `SET ROLE authenticated` + GUC do JWT (psql-ro tem BYPASSRLS — não serve).

---

## 2. Decisões de design (D1–D5) — ALVO DO CODEX

### D1 — Allowlist + flag global (PR0.1)
**Escolha:** tabela dedicada `selfservice_cliente_allowlist(customer_user_id, account, enabled, enabled_by, enabled_at, notes)` (molde `cliente_tier_preco`), + flag global em `company_config['selfservice_produto_enabled']`. Gate do cliente **não** lê `company_config` cru — vem de **RPC SECDEF `selfservice_conta_atual()`** que combina flag ∧ allowlist ∧ `is_approved`, fail-closed. Novo `RequireFeature` (React) consome a RPC.
**Rejeitado:** coluna booleana em `profiles` (multi-writer; `database.md §4` manda coluna/tabela dedicada + 1 writer + auditável); flag em localStorage (não é autz).

### D2 — Escopo das views: **view-gate `security_invoker=off`** (ALVO PRINCIPAL DO CODEX)
**Escolha:** para LEITURA, `CREATE VIEW ... WITH (security_invoker=off, security_barrier=true)` que lê a base **como owner** (bypassa a RLS staff-only) e cujo `WHERE` replica o gate — `customer_user_id=(SELECT auth.uid())` ∧ `account = ANY(accounts_do_caller)` ∧ `selfservice_habilitado()`. Expõe **só colunas seguras** (projeção controlada). `GRANT SELECT TO authenticated`. Padrão já provado no repo (`database.md §4`, MV do badge de reposição).
**Por quê não RLS na tabela base:** adicionar policy customer-facing em `cliente_tier_preco`/`inventory_position` expõe **todas as colunas** via PostgREST (incl. `cmc`/`preco_medio`/`omie_payload`) e mistura autz staff+cliente na mesma superfície. A view-gate projeta.
**Por quê não RPC pura p/ tudo:** RPC não pagina como PostgREST e é pior p/ listas; reservada p/ **preço** (precisa de cálculo, não é projeção) e mutações (Fase 2+).
**InitPlan obrigatório:** todo `auth.uid()`/SECDEF no `WHERE` embrulhado em `(SELECT …)` — senão reavalia por linha e estoura `statement_timeout` (`database.md §4`, caso `tint_formulas` 13,4s→<1s).

### D3 — Empresa/account do cliente
**Escolha:** a **allowlist carrega o `account`** autorizado. `selfservice_conta_atual()` devolve `accounts text[]`. Isolamento multi-empresa (Grupo Colacor) = as views filtram `account = ANY(accounts)`.
**Por quê não derivar de `omie_clientes.empresa_omie`:** é `colacor` p/ 100% dos clientes — não representa a loja de compra.

### D4 — Prova de isolamento (PR0.3)
**Escolha:** harness PG17 (`prove-sql-money-path`) sob `SET ROLE authenticated` + `SET request.jwt.claims`. Semear cliente A (account `oben`), cliente B (account `colacor`), um grupo econômico {A, C'} (docs distintos), staff. Falsificar (sabotar o `WHERE` da view → exigir vermelho).

### D5 — Âncora de pedido/histórico
**Escolha:** `customer_user_id = (SELECT auth.uid())`. `customer_document` está 0% preenchido — inviável hoje. Os 18 pedidos contaminados = dívida documentada (não vazam; só somem do histórico do cliente real). Backfill de `customer_document` + correção do `customerUserId || user.id` fica como **dívida referenciada** (fora do escopo Fase 0, mas registrada).

---

## 3. Esquema proposto (esboço — SQL final pós-Codex)

### 3.1 Allowlist + gate
```sql
CREATE TABLE public.selfservice_cliente_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account text NOT NULL CHECK (account IN ('oben','colacor','colacor_sc')),
  enabled boolean NOT NULL DEFAULT true,
  enabled_by uuid,                       -- trigger força = auth.uid()
  enabled_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  UNIQUE (customer_user_id, account)
);
-- RLS: cliente lê a PRÓPRIA linha; gestor/master gerencia; anti-forje em enabled_by
-- REVOKE ALL FROM anon; ENABLE RLS; policies InitPlan-wrapped

-- Gate canônico (SECDEF, fail-closed):
CREATE FUNCTION public.selfservice_conta_atual()
RETURNS TABLE(customer_user_id uuid, accounts text[], habilitado boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT (SELECT auth.uid()),
    COALESCE((SELECT array_agg(DISTINCT a.account)
              FROM selfservice_cliente_allowlist a
              WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled), '{}'),
    ( COALESCE((SELECT (value)::boolean FROM company_config WHERE key='selfservice_produto_enabled'), false)
      AND COALESCE((SELECT p.is_approved FROM profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      AND EXISTS (SELECT 1 FROM selfservice_cliente_allowlist a
                  WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled) );
$$;
```

### 3.2 As superfícies de leitura (view-gate)
| Superfície | Fonte | Expõe | NUNCA expõe |
|---|---|---|---|
| `selfservice_catalogo` | `omie_products` | codigo, descricao, unidade, familia, account, imagem_url | `valor_unitario` cru, `estoque` |
| `selfservice_meu_tier` | `cliente_tier_preco` | account, tier (do próprio) | tier de terceiros |
| `selfservice_disponibilidade` | `inventory_position` | `(saldo>0)` booleano | `saldo`, `cmc`, `preco_medio` |
| `selfservice_meus_pedidos` | `sales_orders`+`order_items` | numero, data, status, total, itens | `omie_payload`, `omie_response` |
| `selfservice_preco_produto()` (RPC) | tier+markup do próprio | preço final do cliente | comparáveis cross-cliente (leave-one-out) |

Todas com `WHERE customer_user_id=(SELECT auth.uid())` e/ou `account = ANY((SELECT accounts FROM selfservice_conta_atual()))` ∧ `habilitado`.

### 3.3 Hardening `omie_products` (P0 — dentro do PR0.2)
Trocar `SELECT USING(true)` por policy que **não** deixa não-staff ler a tabela crua; catálogo do cliente só pela view-gate. **Risco:** telas `authenticated` não-staff que hoje leem `omie_products` direto (verificar por grep + prova de não-regressão antes de aplicar).

---

## 4. Sequência de PRs + dependências
- **PR0.1** — allowlist + `selfservice_conta_atual()` + flag + `RequireFeature` + UI mínima staff (ligar/desligar cliente). 🟥 prove-sql (gate fail-closed) + Codex.
- **PR0.2** — as 4 views-gate + RPC de preço + hardening `omie_products`. 🟥 prove-sql (isolamento + projeção segura) + Codex.
- **PR0.3** — smoke adversarial de isolamento (PG17 SET ROLE). 🟥.
Dependência: 0.1 → 0.2 → 0.3. Cada um é migration manual (`lovable-db-operator`) + prova PG17 antes de entregar.

## 5. Riscos de autorização a provar (do Codex, + novos)
1. Cliente A vê preço/tier/pedido/estoque/histórico/catálogo de B → **não**.
2. A vê account fora da própria allowlist (outra empresa do Grupo Colacor) → **não**.
3. A vê irmão de grupo econômico (outro CNPJ, doc distinto) → **não** (sem caminho `auth.uid()→doc→grupo`).
4. Cliente chama endpoint staff (`get_regua_preco`, edge `recommend`) → **rejeitado** (regressão a garantir).
5. Cliente infere margem/ruptura por estoque detalhado → **não** (só booleano).
6. Cliente não-aprovado ou fora da flag global → **fail-closed**.
7. View-gate `security_invoker=off` vaza por `WHERE` frouxo → falsificar no PG17.

## 6. Dívidas registradas (fora do escopo, referenciadas)
- **`customerUserId || user.id`** (`submitOrder.ts:171,284`, `submitQuote.ts:58,106`, `helpers.ts:105`) contamina 18 pedidos. Backfill de `customer_document` + fix da fonte → programa à parte.
- Correção do vazamento `omie_products USING(true)` é P0 e entra no PR0.2 (não é dívida — é parte do escopo).

## 7. Perguntas abertas — RESPONDIDAS pelo Codex (ver §8)
- View-gate `security_invoker=off` **pode ficar**, MAS só depois de fechar a base crua + testes REST/embed + proibição de função leaky em coluna sensível.
- Hardening `omie_products` → **PR isolado e PRIMEIRO** (PR0.0), não no PR0.2.

---

## 8. Parecer Codex (gpt-5.5 · xhigh · 2026-07-08) INCORPORADO — v2

**Veredito:** design sólido, **não-executável** sem os fixes abaixo. Convergência total (10/10 aceitos). Mudança estrutural: **a view-gate NÃO é barreira se a tabela base é acessível** — PostgREST não obriga o cliente a usar a view (chama a tabela crua ou faz embed `select=*,rel(col_sensivel)`). Logo **fechar a base crua vem ANTES do self-service**.

### 8.1 Reordenação da Fase 0
- **PR0.0 (NOVO — primeiro) · Fechar a base crua.** 🟥
  - `omie_products`: `SELECT USING(true)` → **staff-only**. Tarefa **BLOQUEANTE**: provar (grep + REST) que nenhum consumidor não-staff lê hoje (customer é services-only; o customer-path de produto ainda não existe). Prova REST direta: JWT authenticated não-staff → **0 linhas** (não só SQL).
  - `sales_orders`/`order_items`: a policy "own" **já existente** expõe `omie_payload`/`omie_response` (jsonb bruto) ao cliente via PostgREST. **REVOKE column-level** `SELECT(omie_payload, omie_response, …)` FROM `authenticated` (staff mantém via policy staff). Prova: embed/coluna direta → negado.
- **PR0.1 · allowlist + gate** (fixes 8.2-D1).
- **PR0.2 · views-gate + RPC preço** (fixes 8.2-D2) — só DEPOIS do PR0.0.
- **PR0.3 · smoke adversarial** (REST/embed + poisoned + anti-doc + contaminação staff + grants).

### 8.2 Deltas por decisão
**D1 (allowlist/gate) — 3 fixes:**
1. `enabled boolean NOT NULL DEFAULT false` (era `true` = default aberto: linha criada por bug/seed nasceria ativa). Ativação **só** via RPC/admin SECDEF que seta `enabled`+`enabled_by`+`enabled_at`. **Cliente SEM IUD** na allowlist (só a RPC de status de leitura).
2. Gate exige **`profiles.is_employee IS FALSE`** (não só `is_approved`) — senão um uid staff (os 18 contaminados) entra como comprador e vê pedidos alheios.
3. Toda RPC nova: `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + grant mínimo; pós-apply provar `has_function_privilege('anon',…)=false` (`database.md §59`: REVOKE FROM PUBLIC não tira anon/authenticated).

**D2 (views) — 3 fixes:**
1. **Remover `selfservice_meu_tier`** — expor tier + preço final deixa o cliente **rederivar CMC** (preço = f(cmc,tier)). A RPC de preço devolve **só o número final** (sem tier/piso/reason/confiança), rate-cap; avaliar **price book pré-computado** (não CMC live).
2. WHERE interno **só comparações simples + gate** — nada de cast/JSON/função em coluna sensível (side-channel: linha "poisoned" de outro account causaria erro/timing ≠ 0-linhas). Teste: poisoned row → **0 linhas, nunca erro**.
3. `s.habilitado IS TRUE AND base.account = ANY(s.accounts)` — **nunca** `COALESCE(…, true)`. `ANY('{}')`/`ANY(NULL)` já falham fechado (P2#9 confirmado seguro); testar `{}`, `NULL`, `{NULL}`.

**D3 — ok** (allowlist carrega `account`).

**D4/D5 (prova/âncora) — fixes:**
- Âncora `customer_user_id=(SELECT auth.uid())` OK p/ linhas limpas; os **18 contaminados = quarentena/exclusão explícita** antes de expor histórico — views de pedido **excluem `customer_user_id ∈ staff`**. Backfill/fix da fonte (`customerUserId||user.id`) = dívida referenciada.
- PR0.3 cobre, além do isolamento A×B: **default privileges** (`has_function_privilege`), **REST/embed direto na tabela crua** (o cliente não é obrigado a usar a view), **poisoned row** (cast leaky), **grupo econômico** (harness A+C mesmo grupo → C invisível) + **teste estrutural** `pg_get_viewdef` proibindo `document`/`cnpj`/`cliente_grupo%` nas views self-service, **contaminação staff** (uid staff no gate → negado), **regressão** (`get_regua_preco`/edge `recommend` seguem rejeitando cliente).

### 8.3 Consumidores de `omie_products` (grep — tarefa bloqueante do PR0.0)
28 call-sites; críticos p/ o hardening: `src/services/orderSubmission/vendabilidade.ts:66` (preflight money-path no submit) e `src/hooks/unifiedOrder/useProductCatalog.ts:9` (catálogo, hoje staff-gated em `useUnifiedOrder.ts:340`). Ambos **staff hoje** → endurecer é seguro AGORA; quando o comprador usar produto (Fase 1+), migram p/ `selfservice_catalogo`/RPC de vendabilidade SECDEF **antes** de qualquer exposição.
