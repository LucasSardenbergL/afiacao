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

### Fatia 3 — re-rótulo + suportar colacor real (migration + prove-sql + Codex)
- `fetchOmieClienteUserMap:230` account-scoped (doc-match, não code-match cross-account) — Codex #1/#7.
- `onConflict:'(user_id,empresa_omie)'`; drop `unique_user_omie` (composta já existe como índice).
- `syncCustomers` seta `empresa_omie=accountToEmpresa(account)`; writers manuais setam `'colacor_sc'` (sem clobber de `'oben'` — só possível pós-composta).
- Popular colacor via `colacor_vendas`. Reverter defesas 1/2/3 da Fatia 1 (mirror colacor confiável).
- **Gate**: prove-sql PG17 (drop constraint + onConflict + re-rótulo derivado) com falsificação + Codex challenge.

## 4. Threat model (Fatia 1)
- **Prova**: verificação Omie por documento no colacor (fail-closed em ausência/ambiguidade/divergência). Guard oben continua provando wrong-account por rótulos CONFIÁVEIS (`'oben'`/`'colacor_sc'` explícitos), só ignora o default `'colacor'`.
- **NÃO prova**: identidade colacor via mirror (ignorado de propósito). Não fabrica: colacor sem match Omie → pedido bloqueado.
- **Default fail-closed**: colacor não-provado via Omie → bloqueia; ambiguidade → bloqueia.

## 5. Decisões (resolvidas com Codex)
- Forçar todo pedido colacor via Omie: **SIM** (gate em "mirror tem colacor" é errado — `'colacor'` é o default envenenado, não prova). Custo: 1 chamada Omie/pedido colacor (infrequente).
- Re-rotular colacor_sc histórico: **NÃO na Fatia 1** (blind relabel inseguro sob a constraint singular) → Fatia 3.
- Deploy: Fatia 1 (edge) primeiro; Fatia 3 corrige o sync/relabel; UI a qualquer momento (fail-safe).
