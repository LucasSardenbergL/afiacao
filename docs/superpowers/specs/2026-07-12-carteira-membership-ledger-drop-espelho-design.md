# Carteira membership ledger — aposentar o espelho `omie_clientes` (P0-B-bis, fatia final) — design

> money-path (identidade de cliente + carteira de vendedor). Conduzido por Claude + `/codex consult` (gpt-5.6-sol, high) que **refutou** a 1ª recomendação (A′) — refutação verificada por leitura direta. Decisão registrada: `06f5d418`. Levantamento por psql-ro (prod) + 2 subagentes de classificação. Deploy PENDENTE do founder. `prove-sql PG17 + REVISÃO INDEPENDENTE DO DIFF (Codex) PENDENTES por fatia`.

## 1. Problema

`omie_clientes` é o espelho `user_id → omie_codigo_cliente`. `empresa_omie` é 100% o default mentiroso `'colacor'` (nenhum dos 6 writers a seta) — código físico é um MIX de contas Omie (oben bulk + colacor_sc manual). Épico P0-B-bis já migrou: syncPedidos (#1285), leitores de display (#1296), writer vendedor→proof (#1293), carteira-rebuild VENDEDOR (#1303). Falta aposentar o espelho de vez.

**A última dependência dura** é a **LISTA de membros** da carteira: `carteira-rebuild` faz `.from('omie_clientes').select('user_id')` ([carteira-rebuild:251](../../../supabase/functions/carteira-rebuild/index.ts)) — só o CONJUNTO de user_ids. Vendedor, alias e flaggeds já vêm de fontes account-corretas. A "proof" account-correta (`omie_customer_account_map`, opção C de uma rodada anterior) é **document-first**, e ~1633 "clones" (user_ids Omie sem `profiles.document`) nunca entram nela.

### Fatos medidos (psql-ro, produção, 2026-07-12)
- `omie_clientes`: **6909** user_ids distintos.
- `omie_customer_account_map` (proof): **5276** distintos (todos com document).
- `proof ∪ customer_canonical_alias(active)` = **6909** = 100% do espelho. Órfãos (só no espelho) = **0**. Aritmética: 5276 + 1633 clones (no alias) = 6909.
- Docs ambíguos (mesmo doc, 2+ users) HOJE = **0**. Aliases: 1633, todos `active`.

## 2. A decisão — opção D (não A′)

Três candidatos ao problema "de onde vem a lista": **A′** (view de união `proof∪alias` + guard de não-encolhimento), **B** (tabela dedicada acumuladora), **C** (popular clones na proof).

**A′ foi REFUTADA pelo Codex e a refutação foi VERIFICADA.** O mecanismo:
- O `carteira-rebuild` faz **upsert-only sem reconciliar ausentes** ([:357](../../../supabase/functions/carteira-rebuild/index.ts), `onConflict: 'customer_user_id'`, sem DELETE). A propriedade que o espelho garante não é "cardinalidade estável" — é **"todo membro já visto continua na entrada para ser reprocessado"**.
- Se um user some da entrada (ex.: doc vira ambíguo → sync o deleta da proof em [omie-analytics-sync:444](../../../supabase/functions/omie-analytics-sync/index.ts) → some da view A′), o rebuild não gera row para ele → **o assignment antigo `U→V` persiste STALE** (vendedor errado continua válido). Isso é o pior resultado money-path — pior que "encolher".
- O guard de cardinalidade não distingue quebra × ambiguidade × consolidação × substituição (mesma contagem, conjunto diferente). Bomba concreta e executável hoje: `mapaConsolidacao` re-executado não-dry-run rebaixa os 1633 aliases `active→inactive` de uma vez ([:1868](../../../supabase/functions/omie-analytics-sync/index.ts), dry_run default false).

**C** é pior (mistura semântica document-first, colide com `UNIQUE(codigo,account)`, delete-de-ambíguos persiste). **B** é conceitualmente correta (membership é fato durável; proof/alias são projeções revogáveis) mas o risco real é o big-bang de 6 writers.

**Opção D = B feita direito.** Ordem de preferência do Codex: **D > B > manter `omie_clientes` > A′ > C**.

## 3. Arquitetura

Separar 4 conceitos que hoje estão colapsados no espelho:

| conceito | natureza | onde vive |
|---|---|---|
| **membership** | fato histórico, **acumulador** (nunca encolhe) | `carteira_membership_ledger` (NOVO) |
| **identity_state** | mutável: `verified`/`ambiguous`/`inactive`/`conflict` | coluna no ledger |
| **eligible** | projeção operacional | `carteira_assignments` (já existe; setado no rebuild) |
| **vendedor** | account-correto | `omie_customer_account_map(_fresco)` (proof, já usada) |

### `carteira_membership_ledger` (tabela nova, aditiva)
- `user_id uuid PK → auth.users ON DELETE CASCADE`
- `identity_state text NOT NULL DEFAULT 'verified' CHECK (identity_state IN ('verified','ambiguous','inactive','conflict'))`
- `first_seen_at timestamptz NOT NULL` — a data REAL do vínculo (backfill copia `omie_clientes.created_at`, ~março; preserva o que `analytics-sync:1566` precisa e a proof não tem)
- `source text CHECK (source IN ('backfill','trigger','rpc'))`
- `updated_at timestamptz DEFAULT now()`
- RLS espelhando `omie_clientes`: Staff ALL (`has_role master|employee`), user SELECT próprio. Índice `(identity_state)`.

**Invariante central:** um user_id, uma vez no ledger, **nunca é removido** — transições de identidade mudam `identity_state`, nunca a presença. "Ausente da entrada" **nunca** é interpretado como revogação.

### Fluxo do rebuild (novo)
1. Lê **todos** os membros do ledger (acumulador → cobertura estável, sem depender do frescor de sync).
2. Para cada membro: vendedor via proof oben; alias via `customer_canonical_alias`; flaggeds via `cliente_classificacao`.
3. `identity_state ∈ {ambiguous,conflict}` → **quarantined**: vendedor removido, `eligible=false`, membro preservado, **zero comissão** (transição correta do Codex para doc-ambíguo).
4. Reconcilia: todo membro do ledger → uma row em `carteira_assignments`.

### Quem seta `identity_state`
- backfill/trigger → `verified` (default).
- sync que deleta da proof por ambiguidade ([analytics-sync:444](../../../supabase/functions/omie-analytics-sync/index.ts)) → `ambiguous` no ledger (em vez de o user sumir).
- `mapaConsolidacao` alias `inactive`/`conflict` → reflete no ledger do clone.

## 4. Levantamento — 17 sítios (classificados; ruído de tipos/comentários/UI excluído)

### 🔴 ESCRITORES — 6 pontuais (migram p/ RPC `register_carteira_member` na Fatia 4) + 1 bulk (§9)
| sítio | fluxo | nota |
|---|---|---|
| `Auth.tsx:133` | signup (frontend direto) | grava `omie_codigo_cliente_integracao` (proof não tem) |
| `AdminApprovals.tsx:113` | aprovação (frontend direto) | gate-leitor `:92` (`already_linked`) é par indivisível |
| `omie-cliente:654` | `criar_perfil_local` (match doc) | fluxo de pedido |
| `omie-cliente:705` | `criar_perfil_local` (placeholder novo) | |
| `omie-cliente:829` | `sync_all_clients` (import massa) | único que grava `..._integracao` |
| `omie-sync:371` | write-back self-service | já anotado `TODO Fatia 4` |
| *(bulk)* `analytics-sync:468` | bulk oben (`account='vendas'`) | o principal; já popula a proof em `:482` |

### ⭐ Leitor da LISTA (o coração) → migra p/ ledger
- `carteira-rebuild:251`

### 🟡 Leitores de código/vendedor → migram p/ proof
- **6 OBEN (troca mecânica `.eq('account','oben')`, baixo risco):** `useBuscaClienteOmie:35/78`, `useCustomerSelection:209/247`, `FarmerCalls:213/312`
- **money-path pedido (JÁ neutralizados — filtram `empresa_omie` que nunca é real → retornam `[]` → fallback API):** `omie-vendas-sync:1751/2441`, `useUnifiedOrder:516/562`
- **edges:** `omie-cliente:627/750/909`, `ai-ops-agent:250` (vendedor), `analytics-sync:238/550/1566` (auto-consumo; `:1566` precisa de `created_at` → coberto pelo ledger)
- **JÁ migrado (não bloqueia):** `SalesPrintDashboard:215` (via view fresca)

## 5. Fatiamento (multi-PR, aditivo → cada passo fail-safe)

- **Fatia 0 — fundação (migration):** cria `carteira_membership_ledger` + backfill dos 6909 (com `first_seen_at`=`omie_clientes.created_at`) + trigger `AFTER INSERT` em `omie_clientes` (`ON CONFLICT DO NOTHING`, `source='trigger'`). O trigger cobre os 6 writers **sem tocá-los** durante a transição. **prove-sql PG17** (CREATE + RLS sob `SET ROLE` + trigger + falsificação).
- **Fatia 1 — rebuild lê o ledger:** `carteira-rebuild:251` → ledger; reconcilia `identity_state`→eligible/quarantined; vendedor da proof. **prove-sql** (paridade do helper `rebuild-helpers` + guard). Fecha a decisão-chave.
- **Fatia 2 — popular `identity_state`:** sync marca `ambiguous` no ledger ao deletar da proof (`:444`); `mapaConsolidacao` reflete `inactive`/`conflict`. Torna o `quarantined` real. **Independente da Fatia 1:** até rodar, todos ficam `verified` (default) → rebuild = comportamento de hoje; a Fatia 2 só ATIVA o quarantine (aditivo, fail-safe).
- **Fatia 3 — migrar leitores de código → proof:** 6 OBEN + edges. Baixo risco (já degradados). Frontend Publish + edges.
- **Fatia 4 — migrar 6 writers → RPC `register_carteira_member`:** escreve ledger (membership) + proof (`source='manual'` p/ o código account-correto) e **para** de escrever o espelho. Ordem: leitores antes dos writers; gate `AdminApprovals:92` casa com seu writer `:113`.
- **Fatia 5 — DROP:** removido o último leitor/escritor e o trigger ocioso → `DROP TABLE omie_clientes` + regenerar `types.ts`. **prove-sql PG17 + lovable-db-operator**.

## 6. Invariantes / error handling
- Ledger **nunca** perde membro (acumulador). "Ausente" ≠ revogação.
- Doc ambíguo → `quarantined` (vendedor null, eligible=false, membro vivo, zero comissão) — **não** remove da lista, **não** deixa vendedor stale.
- Todo passo é aditivo: ledger/coluna vazios → consumidores degradam como hoje (fail-safe).
- Trigger + backfill cobrem 100% durante a transição; só a Fatia 4 desacopla os writers; só a Fatia 5 dropa.

## 7. Testing (prove-sql PG17, por fatia money-path/DDL)
- Fatia 0: CREATE real + RLS sob `SET ROLE authenticated` + GUC; backfill preserva `first_seen_at`; trigger idempotente (`ON CONFLICT`); falsificação (sabotar CHECK/trigger → exigir vermelho).
- Fatia 1: paridade `computeCarteira` edge×`src/lib/carteira/rebuild-helpers.ts`; asserts +/- do quarantined; guard de baseline preservado.
- Fatia 4/5: RPC prova positiva+negativa; DROP só após grep zero de leitor/escritor.

## 8. Deploy (ordem, por fatia)
Migration (SQL Editor) → edge (chat Lovable, verbatim) → rodar/backfill → validar (psql-ro: cobertura, 0 ambiguidade) → Publish frontend. Cada fatia é PR próprio (auto-merge no CI verde). Épico QUENTE: coordenar com `omie-identidade` (A1 #1298 / A2) e `carteira-vendedor-oben-hardening` antes de tocar `omie-analytics-sync` / `carteira-rebuild`.

## 9. Resíduos conhecidos
- `omie_codigo_cliente_integracao` (writers `Auth`/`AdminApprovals`/`omie-cliente:829`): decidir na Fatia 4 se a proof ganha a coluna ou se é descartada (nenhum leitor a consome — candidata a descarte).
- `analytics-sync:468` (bulk oben) é o único writer que também alimenta a proof; pode ser o último a largar o espelho ou parar quando ledger+proof estabilizarem.
