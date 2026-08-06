# Leituras money-path do espelho `omie_clientes` poluído — P0-B-bis — design

> **money-path** (identidade de cliente/vendedor → pedido, atribuição, carteira). Resíduo do P0-B/#1204: o hardening de filtro-por-conta foi aplicado ao caminho de pedido do **frontend**, mas **~6 leitores money-path do backend/edge seguem lendo o espelho poluído sem conta**. Elevado à decisão do founder a partir do débito registrado no §7 do spec `2026-07-09-omie-proof-table-staleness-doc-ambiguo-design.md` ("item extra do challenge, P1"). Conduzido por Claude + `/codex challenge` (parecer na §9). Deploy PENDENTE do founder.

## 1. Problema

`omie_clientes` é o espelho legado `user_id → omie_codigo_cliente/omie_codigo_vendedor`. A coluna `empresa_omie` (rótulo de conta) é **100% `'colacor'`** — mentira uniforme: nenhum writer a seta (default). O conteúdo real é um **mix de contas** cujo código físico não tem relação com o rótulo.

O P0-B endureceu o **caminho de pedido do frontend** (`useUnifiedOrder`, `useCustomerSelection`, `useBuscaClienteOmie`, `FarmerCalls`) com `.eq('empresa_omie','oben')` — um **fail-closed deliberado**: como o espelho não tem linha `'oben'`, o filtro dá vazio → o fluxo cai no fallback autoritativo (API Omie por documento). Precisão>recall.

**Mas os leitores money-path do backend/edge NÃO foram endurecidos** — leem o espelho por `user_id`/código **sem filtro de conta** e usam o resultado direto. Como o espelho é 1 linha/user (`UNIQUE(user_id)`) com código de uma conta possivelmente **≠** da conta do fluxo, o downstream usa um código/vendedor **da conta errada**, silenciosamente.

## 2. Evidência (psql-ro, produção, 2026-07-09)

**Espelho `omie_clientes`:** 6909 linhas, **100% rótulo `'colacor'`** (`count(distinct empresa_omie)=1`, `empresa_omie<>'colacor'`=0). Cruzando o código físico com a proof-table account-correta `omie_customer_account_map`:

| onde o código do espelho "casa" | linhas | % |
|---|---|---|
| colacor_sc | 3642 | 53% |
| colacor | 1632 | 24% |
| **oben** | **2** | ~0% |
| nenhuma conta (órfão/stale) | 1633 | 24% |

O rótulo `'colacor'` é falso e o conteúdo é **colacor_sc-dominante**. Nota: `casa_oben=2` apesar de o sync `vendas`/oben reportar `total_synced=5238` (05:03) — indício de sobrescrita pelos writers colacor_sc ao longo do dia (mecanismo não cravado; não altera o design).

**Proof-table `omie_customer_account_map`** (fonte account-correta, document-first, cron diário 05:00–05:40, view fresca 7d do #1268): oben **5238**, colacor **5156**, colacor_sc **5275**. Cobertura ~76% dos users do espelho; o restante degrada a vazio → fallback API (aceitável, fail-closed).

**doc-ambíguo-no-profile = 0** hoje (nenhum documento com 2+ users) — o fenômeno de doc duplicado é raríssimo neste B2B (1 CNPJ = 1 conta), o que reforça que remendar a *escrita* (o débito do §7) tem valor ínfimo; o risco vivo é a *leitura* sem conta.

## 3. Princípio de correção (converge com a Fatia 4)

**Não remendar o espelho — migrar cada leitor money-path para a VIEW fresca `omie_customer_account_map_fresco`** (NÃO a tabela base — Codex P1: a base reabre stale infinito; a view filtra `updated_at >= now()-7d`), filtrando a **conta correta do fluxo**, com **fallback fail-closed à API Omie por documento** onde a proof não cobre. O fallback API **também** precisa ser fail-closed em doc-ambíguo (Codex P1: buscar 2+ registros e rejeitar ambiguidade — o `registros_por_pagina:1` atual é last-write-wins, ver §4).

Isto **é** a maior parte da Fatia 4: quando os leitores money-path saírem do espelho, ele fica só com writers + leitores housekeeping (ℹ️) → aposentável (o DROP é o fecho da Fatia 4, fora deste escopo).

**Por que a view fresca, não filtro-vazio:** o filtro `.eq('empresa_omie','oben')` do frontend degrada a vazio (sempre fallback API). A view tem o **código correto** por conta (oben/colacor/colacor_sc) e só o vínculo visto no Omie nos últimos 7d — melhor cobertura, menos chamadas API, mesmo fail-closed na ausência/staleness.

**Pré-condição de rollout (Codex P1, PROVADO):** a proof-table só é fonte segura com o **P1b re-aplicado e deployado** (o [#1272](../../../) restaura o P1b que o deploy do Lovable reverteu — sem ele a proof grava código ambíguo por last-write-wins). PR-1 só começa após #1272 mergeado + edge redeployada + 1 run do sync.

## 4. Inventário dos leitores money-path e tratamento

Vocabulário de conta: `accountToEmpresa`: `vendas→oben`, `colacor_vendas→colacor`, `servicos→colacor_sc`. A proof usa `account ∈ {oben, colacor, colacor_sc}`.

Fonte = view `omie_customer_account_map_fresco` (não a base). Contas confirmadas pelo Codex: omie-sync=colacor_sc (`OMIE_COLACOR_SC_APP_KEY`:99); syncPedidos por-conta (:175); carteira/cockpit=oben (`fin-valor-cockpit` fixa `COMPANY="oben"`:333, carteira-rebuild = cadastro Oben canônico).

| # | Leitor | Conta | Tratamento | PR |
|---|---|---|---|---|
| 1 | `omie-sync:236` — código+vendedor p/ **pedido self-service** | colacor_sc | view fresca `(user_id, account='colacor_sc')`; ausência → fallback API **fail-closed** (buscar 2+ registros, rejeitar doc-ambíguo — Codex P1; hoje `registros_por_pagina:1` :257 é last-write-wins; reusar padrão de `buscarClienteVendasMatches` omie-vendas-sync:1637). Write-back espelho (:284) = writer → Fatia 4. | PR-1 |
| 2 | `omie-sync:786` — fallback vendedor (pedido staff) | colacor_sc | view `omie_codigo_vendedor` por conta | PR-1 |
| 3 | `omie-sync:981` — `check_client` | colacor_sc | view por conta; ausência → API fail-closed | PR-1 |
| 4 | `omie-vendas-sync:918` — `syncPedidos` cache código→user | por-conta (`oben`\|`colacor`) | view `.eq('account', account)`; **migra SOZINHO** (Codex) | PR-2 |
| 6 | `carteira-rebuild:190` — user×vendedor p/ carteira | oben | view `omie_codigo_vendedor` `account='oben'` | PR-3 |
| 8 | `fin-valor-cockpit:437` — user→código (display) | oben | view por conta (ℹ️ baixo) | PR-4 |
| 9 | `Customer360.tsx:65` — lê `empresa_omie` (inútil, 100% `'colacor'`) | — | derivar conta da view | PR-4 |
| 11 | `useUnifiedOrder.ts:632` — `handleStaffAddTool` resolve user por código sem conta | oben | filtrar conta/derivar (Codex P2 — anexa ferramenta ao cliente errado em colisão) | PR-4 |
| 12 | `SalesPrintDashboard.tsx:185` — `.eq('empresa_omie','colacor')` p/ endereço | colacor_sc | migrar p/ view; comentário assume "colacor=colacor_sc" mas há 24% colacor+24% órfão (Codex P2) | PR-4 |
| 10 | view `v_grupo_contatos` (join sem conta) | oben | join à view; prove-sql se tocar a view | PR-4 |

### FORA da P0-B-bis (Codex — não são migração-de-fonte simples)

- **#5 `omie-vendas-sync` guard `codeBelongsToWrongAccount`** (`src/lib/omie/account-coherence.ts:15`): o helper **só acusa ao ver uma linha de OUTRA conta** com o mesmo código. Filtrar só a conta-alvo **desliga a proteção** (o caso `colacor111` enviado como `oben` vira ausência → passa). Migração correta = ler **TODAS as contas frescas do user** e preservar o teste P0-A → **PR próprio com prove-sql** (ou Fatia 4, junto com o pedido).
- **#7 `ai-ops-agent:281`** grava `farmer_id = assignment?.user_id` (o próprio cliente vira farmer — bug **semântico**, não de conta; `omie_codigo_vendedor` e `employees` buscados mas não usados). Trocar a fonte não conserta → **fix próprio** (mapear vendedor→employee ou consumir `carteira_assignments`).

## 5. Fatiamento (PRs pequenos, risco money-path decrescente)

**PR-0 (pré-condição, já em voo):** [#1272](../../../) re-aplica o P1b revertido pelo Lovable + redeploy da edge + 1 run do sync. **Bloqueia PR-1** (a view fresca precisa de proof não-ambígua).

- **PR-1 — `omie-sync` (self-service):** #1,2,3. O mais crítico. Migra p/ view fresca + **fallback API fail-closed** (2+ registros). Edge TS puro. Gate: codex + typecheck/test + canário textual anti-reversão-Lovable.
- **PR-2 — `omie-vendas-sync syncPedidos`:** #4 **isolado** (guard SAIU — Codex). Migra o cache p/ view `.eq('account',account)`. Gate: codex + test.
- **PR-3 — `carteira-rebuild`:** #6 (vendedor→carteira, `account='oben'`). ai-ops SAIU. Gate: codex + test.
- **PR-4 (ℹ️ baixo) — display/UI:** #8, #9, #10, #11, #12. Gate: test (+ prove-sql se tocar `v_grupo_contatos`).
- **PRs próprios (fora, registrados):** guard `codeBelongsToWrongAccount` (multi-conta + prove-sql) · fix semântico `ai-ops-agent` (farmer_id).

## 6. Threat model / fail-closed

- **Prova:** identidade por (user_id, conta-do-fluxo) na view fresca account-correta (document-first, fail-closed em doc ambíguo pelo P1b — #1268 re-aplicado no #1272). Ausência na view → fallback API por documento **fail-closed em ambiguidade** (2+ registros → rejeita, Codex P1) ou bloqueio (pedido) — **nunca** usa código de conta arbitrária do espelho.
- **NÃO prova / degrada:** user sem linha fresca na conta → sem código → API fail-closed ou `[]`/null honesto (como o frontend hoje).
- **Staleness:** view fresca 7d (#1268); o espelho é diário sem TTL. View+fallback ≥ status quo. O `data_health_watchdog` grita antes de 7d. Risco de 7d no pedido self-service assumido explicitamente (§10 P2).

## 7. Gate (por PR)

- **prove-sql-money-path** (PG17 + falsificação): só onde houver SQL/constraint/guard novo — PR-2 (guard) e PR-4 (view). PR-1/PR-3 são edge TS puro → sem prove-sql.
- **/codex challenge do diff** por PR (money-path).
- **Canário textual** em `edge-money-path-invariants.test.ts`: assert da leitura account-correta (pega reversão do Lovable no deploy da edge).
- **typecheck + test + lint.**

## 8. Deploy (ordem — cada leitor é fail-safe isolado)

Sem migration nova para PR-1/PR-3 (só edge). Por PR: (1) deploy edge pelo chat do Lovable (verbatim); (2) validar (psql-ro: outcomes não regridem; canário verde). PR-4 (view) segue o rito lovable-db-operator. Aditivo/isolado: cada leitor migrado degrada a fallback se a proof faltar — nunca corrompe.

## 9. O que NÃO entra (fora de escopo — evita expansão)

- **DROP do espelho `omie_clientes`** — fecho da Fatia 4, após TODOS os leitores (incl. housekeeping) migrarem.
- **Writers** (`omie-cliente`, `omie-sync` write-back :284, `omie-analytics-sync`, `Auth` signup) — seguem gravando `'colacor'` default; não corrompem leitor que já lê a proof. Migração/aposentadoria = Fatia 4.
- **Leitores housekeeping ℹ️** (linking/naming/dedup/consolidação em `omie-analytics-sync`, `omie-cliente`) — não roteiam dinheiro.
- **O fix-ponte de doc-ambíguo na escrita do espelho** (o débito do §7) — **descartado** (valor ínfimo: writer oben marca 2/6909; doc-ambíguo-profile=0; código descartável na Fatia 4).

## 10. Decisões (Codex challenge, gpt-5.5 xhigh, 2026-07-09)

Parecer cru arquivado (`scripts/codex-async.sh`). **Convergiu com a direção** ("tirar money-path do espelho e ler por `(user_id, account)` é o caminho certo"). Achados incorporados:

- **P1 (view fresca) — ACEITO:** ler `omie_customer_account_map_fresco`, nunca a base (senão stale infinito). → §3, §4.
- **P1 (fallback fail-closed) — ACEITO:** `omie-sync` fallback usa `registros_por_pagina:1` (:257) = last-write-wins; para pedido, buscar 2+ e rejeitar doc-ambíguo (padrão `buscarClienteVendasMatches`). → #1, PR-1.
- **P1 (guard fora) — ACEITO:** migrar `codeBelongsToWrongAccount` com filtro só na conta-alvo **desliga a proteção** (só acusa vendo outra conta). Tirado do PR-2; `syncPedidos` migra sozinho; guard = PR próprio multi-conta + prove-sql. → §4 FORA, §5.
- **P1 (pré-condição P1b) — ACEITO + PROVADO:** a proof só é segura com o P1b deployado; descobri que o Lovable o reverteu (#1272 corrige, canário vermelho→verde). → §3 pré-condição, PR-0.
- **P2 (regressão vs frontend) — ACEITO com contrato:** a proof é cache (≤7d) enquanto o frontend força API. Para `omie-sync` assumimos explicitamente o risco de 7d (≥ status quo do espelho sem TTL; watchdog grita antes) + fallback API fail-closed. Alternativa (API sempre) fica registrada se o founder priorizar precisão absoluta.
- **P2 (inventário) — ACEITO:** incluídos `useUnifiedOrder:632` (#11) e `SalesPrintDashboard:185` (#12). → §4, PR-4.
- **P2 (ai-ops semântico) — ACEITO:** `farmer_id = user_id do cliente` é bug próprio, não de conta → fora da P0-B-bis. → §4 FORA.
- **Validações do Codex:** omie-sync=colacor_sc, syncPedidos por-conta, carteira/cockpit=oben — todas confirmadas no código. → §4.

**Ordem final (Codex):** PR-0 (#1272) → PR-1 (omie-sync, pós pré-condições) → PR-2 (syncPedidos isolado) → PR-3 (carteira) → PR-4 (display). Guard e ai-ops em PRs próprios.
