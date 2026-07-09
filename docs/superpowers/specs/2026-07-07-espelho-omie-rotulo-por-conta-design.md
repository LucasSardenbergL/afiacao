# Espelho Omie — rótulo `empresa_omie` por conta (mislabel oben/colacor_sc) — design

> money-path (identidade de cliente no pedido). Conduzido por Claude + `/codex consult`×2 (metodologia + design refinado), high. Deploy PENDENTE do founder. `REVISÃO INDEPENDENTE DO DIFF PENDENTE` (Codex challenge do diff, após implementação de cada fatia).

## 1. Problema

`omie_clientes` é o espelho `user_id → omie_codigo_cliente`. A coluna `empresa_omie` (NOT NULL DEFAULT `'colacor'`) deveria dizer de qual conta Omie é o código — mas **nenhum dos 5 writers a seta**, então as 6909 linhas caem no default `'colacor'`. O código físico é um **MIX de duas contas**, nenhuma colacor real:

| Writer | App key / conta | Código | Rótulo hoje |
|---|---|---|---|
| `omie-analytics-sync:334` `syncCustomers` (bulk, cron `account:"vendas"`) | `OMIE_OBEN_APP_KEY` | **oben** | `'colacor'` (default) |
| `omie-cliente:829`, `omie-sync:282`, `Auth.tsx:129` (signup), `AdminApprovals.tsx:109` (via `omie-cliente`) | `OMIE_COLACOR_SC_APP_KEY` | **colacor_sc** | `'colacor'` (default) |

Códigos Omie têm numeração independente por conta (colidem entre contas). O rótulo `'colacor'` é uma mentira uniforme sobre dois namespaces.

### Evidência (psql-ro, produção, 2026-07-07)
- `omie_clientes`: 6909 linhas, 100% `'colacor'` (0 oben, 0 colacor_sc).
- Crons `sync-customers-vendas-daily` / `sync-products-customers-daily`: ambos `account:"vendas"` (=oben).
- Overlap de códigos de `customer_preferred_items` com o espelho: oben 20/21 (95%), colacor 0/23 (0%). `customer_segments` (100% oben): 29/30 casam por código, todas sob `'colacor'`.

## 2. Impacto money-path (2 bugs ATIVOS + features inertes)

Consumidor `omie-vendas-sync` (pedido): `type Account="oben"|"colacor"`; lê o espelho com `.eq('empresa_omie',account)`.

- **BUG-1 — pedido colacor no cliente errado** (integridade, silencioso). `deriveOmieAccountIdentity` verifica contra o Omie só com `suppliedCodigo===null` (`:1699`). Para colacor, o mirror `.eq('colacor')` devolve a linha envenenada; se o payload trouxe o código (as vias-cliente do P0-B filtram `empresa_omie`, então mandam), `decideAccountIdentity:1613` aceita `source='mirror'` sem verificar → `criarPedidoVenda` usa o código na conta colacor.
- **BUG-2 — pedido oben legítimo bloqueado** (disponibilidade). `codeBelongsToWrongAccount:1574`: pedido oben, código oben correto, linha rotulada `'colacor'` → existe row com o código e empresa≠oben → `true` → bloqueia.
- **Features inertes**: `compare-customer-process` e `customer360` cruzam o espelho com `customer_segments`/`customer_preferred_items` (namespace oben). Voltam quando o oben for identificável.

## 3. Fatiamento (3 fatias — Codex derrubou "re-rotular na Fatia A")

**Insight do Codex (2ª rodada):** re-rotular dados sob `unique_user_omie` (1 linha/user) é inseguro — `fetchOmieClienteUserMap:230` casa por código sem account (colisão prova user errado) e `onConflict:'user_id'` faz re-rótulo × writers brigarem por last-wins. Multi-conta EXIGE a constraint composta. Logo: **fechar os bugs por CÓDIGO (defesa), não por dados**; re-rótulo só na fatia que traz a composta.

### Fatia 1 — fechar o BUG-1 (integridade) (edge, código puro, SEM dados/migration) ✅ IMPLEMENTADA
1. **BUG-1**: em `deriveOmieAccountIdentity`, no query do espelho (`omie-vendas-sync:1687`), guard `userIds.length===1 && account !== "colacor"` → para colacor `mirrorRows=[]` → `needOmie` → verificação Omie por documento. DENTRO da função → cobre criação (`:2388`) E edição (`:2596`).
2. **BUG-1 (backfill)**: backfill desabilitado para colacor (`:1710`, `&& account !== "colacor"`) enquanto `unique_user_omie` existir — senão a verificação forçada dispara upsert `p_empresa:'colacor'` que pode contest/fail e **bloquear** o pedido colacor legítimo (Codex #4).
- **Gate**: teste textual em `edge-money-path-invariants.test.ts` (pega reversão do Lovable no deploy) + typecheck + test. Sem SQL, sem helper puro tocado → sem prove-sql, sem paridade nova.

> **BUG-2 (false-reject oben) NÃO entra na Fatia 1 — DIVERGÊNCIA JUSTIFICADA do Codex (#5, round-2).** Fechá-lo agora exige mexer em `codeBelongsToWrongAccount`, o que **inverte o teste P0-A** (`account-coherence.test.ts:14`, validado por Codex) e **desliga a proteção** sobre 100% das linhas (todas `'colacor'` hoje). BUG-2 é disponibilidade (fail-closed, trava venda, NÃO perde dinheiro), não integridade. O re-rótulo da **Fatia 3** o resolve na RAIZ (linha vira `'oben'` → `matchesTarget` → guard não bloqueia) sem desligar nada. Precisão>recall: não desligo defesa money-path sem necessidade crítica. `REVISÃO INDEPENDENTE DESTA DIVERGÊNCIA PENDENTE` (Codex round-3).

### Fatia 2 — reconectar features oben (UI, código)
- `compare-customer-process`: remover `.eq('empresa_omie','oben')` → lookup por `user_id` + **fail-close exigindo exatamente 1 linha** (não `.maybeSingle()` cego) + `.eq('account','oben')` em `customer_segments` (segment lookup `:237` e reverse-map `:267`).
- `hooks.ts useCustomerPreferredItems`: de `[]` para lookup por `user_id` + `.eq('account','oben')` em `customer_preferred_items` + fail-close 1-linha.
- Funciona hoje (espelho é oben-majority sob `'colacor'`; user cuja linha é colacor_sc → código não casa segments/preferred oben → null honesto).
- **Gate**: typecheck + test.

### Fatia 3 — **opção C: tabela nova aditiva `omie_customer_account_map`** (migration aditiva + prove-sql + Codex)

> **Decisão (Codex consult high, 2026-07-08): C sobre A e B.** B (proof-table derivada de `sales_orders`) está **morta**: `omie_payload->'cabecalho'->>'codigo_cliente'` só existe em **6 (colacor) + 14 (oben)** pedidos de ~30k → cobre ~17 users (psql-ro). A (re-rótulo in-place do espelho) é arriscada: `DROP unique_user_omie` quebra `onConflict:'user_id'` em ~5 pontos, `.eq('user_id').maybeSingle()` vira 406-ambíguo em `omie-sync`/`omie-cliente`, colisão de linha 'colacor' stale, e o rebuild precisa ser document-first ou casa no user errado. **C é aditiva e reversível**: cria uma tabela nova, não dropa constraint, não muta o espelho poluído, não toca o caminho money-path do pedido (Fatia 1 já o blinda).

**Fonte (igual a A):** re-sync do Omie **por documento** (`profiles.document`, 5276/5276 com doc) — NÃO por código (evita colisão cross-account). Vocabulário `account ∈ {'oben','colacor','colacor_sc'}` = `empresa_omie` (mesmos valores de `customer_segments`/`customer_preferred_items`).

1. **Migration (aditiva, SQL Editor):** `CREATE TABLE omie_customer_account_map (id, user_id→auth.users ON DELETE CASCADE, account text CHECK(∈3), omie_codigo_cliente bigint, omie_codigo_vendedor bigint, source text CHECK('document'|'code'|'manual'), created_at, updated_at)`. `UNIQUE(user_id, account)` + `UNIQUE(omie_codigo_cliente, account)`. RLS ON espelhando `omie_clientes`: Staff ALL (`has_role master|employee`) + user SELECT próprio (`auth.uid()=user_id`). Índice `(user_id)`.
2. **Sync document-first (edge):** função/modo que enumera `ListarClientes(account)` (reusa paginação do `syncCustomers`), casa por **documento** → `user_id`, upsert `(user_id, account=accountToEmpresa(account), omie_codigo_cliente, omie_codigo_vendedor, source='document')` `onConflict (user_id, account)`. Roda p/ `vendas`(oben)+`colacor_vendas`(colacor)+`servicos`(colacor_sc). Cron próprio ou anexado.
3. **Consumidores de LEITURA que migram (só 2 arquivos):**
   - `hooks.ts useCustomerPreferredItems`: de `[]` → lê as linhas da tabela nova por `user_id` (N contas/user) → `.in(códigos)×.in(accounts)` em `customer_preferred_items` + **filtro dos PARES exatos `(código,account)` em memória** (o produto cartesiano do `.in×.in` traz colisão cross-account; o filtro descarta — SEM `.or()` cru, guard-rail CLAUDE.md). **Traz oben E colacor** (preferred tem 523 oben + 979 colacor).
   - `compare-customer-process`: 2 pontos (segment lookup :229, lookalikes reverse-map :281) trocam `omie_clientes` → `omie_customer_account_map`, mantendo `account='oben'`. `.maybeSingle()` seguro na tabela nova.
   - (`useCustomerSegments.ts` é localStorage de filtros de UI — NÃO é consumidor da tabela; falso-positivo.)
4. **Espelho velho `omie_clientes` INTOCADO.** Nada de drop, nada de re-rótulo, nada de deleção.

**Escopo / o que NÃO entra (→ Fatia 4 futura):** o caminho do **PEDIDO** (`omie-vendas-sync`) NÃO migra aqui — continua no espelho velho + Fatia 1. Logo **BUG-2 (oben false-reject no pedido) PERSISTE** como resíduo conhecido (disponibilidade, fail-closed, não perde dinheiro). Fatia 4 migra o pedido p/ a tabela nova, fecha BUG-2 na raiz, reverte a Fatia 1 e aposenta o espelho.

- **Deploy (ordem):** (1) migration aditiva (SQL Editor); (2) edge (sync novo + compare migrado); (3) rodar o sync → popula; (4) validar no banco (psql-ro: cobertura, sem ambiguidade `(user,account)`); (5) Publish frontend (hooks migrado). Aditivo → cada passo é fail-safe (tabela vazia = consumidores degradam a `[]`/null, como hoje).
- **Gate:** prove-sql PG17 (CREATE TABLE real + RLS sob `SET ROLE authenticated` + GUC; UNIQUE(user,account) e UNIQUE(codigo,account); asserts +/- com SQLSTATE; falsificação: sabotar CHECK/UNIQUE → exigir vermelho) + Codex challenge do diff + typecheck + test.
- **Codex challenge do diff (2026-07-08, high): sem P1.** Corrigidos os P2: (1) `fetchProfileDocUserMap` fail-closed em documento com 2+ users (ambíguo → não mapeia, afeta espelho E proof-table); (2) `.eq('account','oben')` nas 2 leituras de `customer_segments` no compare (à prova de futuro se surgir segment colacor). **Resíduo P2 aceito:** `UNIQUE(código,account)` pode abortar um chunk de 500 do upsert se um código mudar de dono entre syncs (raro; fail-closed é correto — não sobrescreve; consumidores degradam a vazio, nunca dado errado). P3: filtro de pares do hook é mecanicamente correto (chave dos mesmos campos nos 2 lados).

## 4. Threat model (Fatia 1)
- **Prova**: verificação Omie por documento no colacor (fail-closed em ausência/ambiguidade/divergência). Guard oben continua provando wrong-account por rótulos CONFIÁVEIS (`'oben'`/`'colacor_sc'` explícitos), só ignora o default `'colacor'`.
- **NÃO prova**: identidade colacor via mirror (ignorado de propósito). Não fabrica: colacor sem match Omie → pedido bloqueado.
- **Default fail-closed**: colacor não-provado via Omie → bloqueia; ambiguidade → bloqueia.

## 5. Decisões (resolvidas com Codex)
- Forçar todo pedido colacor via Omie: **SIM** (gate em "mirror tem colacor" é errado — `'colacor'` é o default envenenado, não prova). Custo: 1 chamada Omie/pedido colacor (infrequente).
- Re-rotular colacor_sc histórico: **NÃO na Fatia 1** (blind relabel inseguro sob a constraint singular) → Fatia 3.
- Deploy: Fatia 1 (edge) primeiro; Fatia 3 corrige o sync/relabel; UI a qualquer momento (fail-safe).
- **Fatia 3 = C (tabela nova aditiva), NÃO A (re-rótulo in-place) nem B (proof-table de `sales_orders`)** — Codex consult high, 2026-07-08. B morta (17 users de cobertura); A arriscada (drop de constraint + `.maybeSingle()` ambíguo + colisão stale + rebuild colisão-inseguro); C aditiva/reversível/sem tocar o money-path do pedido. Fonte de C = re-sync Omie por documento (mesma de A). BUG-2 fica p/ Fatia 4 (migrar o pedido p/ a tabela nova).
- **Fatia 4 (futura, não agora):** migrar `omie-vendas-sync` p/ ler `omie_customer_account_map` (fecha BUG-1 e BUG-2 na raiz), reverter defesas da Fatia 1, aposentar o espelho `omie_clientes`.
