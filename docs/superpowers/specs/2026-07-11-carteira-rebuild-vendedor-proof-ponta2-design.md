# P0-B-bis ponta 2/2 — carteira-rebuild lê o vendedor account-safe da proof

**Data:** 2026-07-11 · **Money-path** (vendedor → carteira → comissão) · **Edge que já bloqueou 2× no Codex**

## Incidente & estado

A carteira ficou **100% Hunter** (6909 assignments, 0 `source='omie'`). Causa-raiz (ponta 1, já
mergeada em #1293): o writer gravava `omie_codigo_vendedor` de `c.codigo_vendedor` (raiz vazio no
ListarClientes) — o vendedor mora em `recomendacoes.codigo_vendedor`. A **ponta 1** corrigiu o
_writer_: popula o vendedor account-safe **só na proof** `omie_customer_account_map` (document-first)
via helper puro `extrairCodigoVendedor` (`src/lib/omie/codigo-vendedor.ts`). O mirror `omie_clientes`
**não** recebe vendedor (decisão da ponta 1).

Esta **ponta 2** faz `carteira-rebuild` **ler o vendedor da proof** em vez do espelho poluído.

### Approach ingênuo — BLOQUEADO pelo Codex R2 (commit `a8933f5a`, revertido em `5acd146e`)

Trocar `.from('omie_clientes')` → `.from('omie_customer_account_map_fresco').eq('account','oben')`.
3 P1: **(#1)** filtrar oben tira os clones da lista → herança B-lite quebra → gêmeo vira Hunter;
**(#2)** cobertura 6909→5238 deixa 1671 excluídos stale (upsert-only, sem delete); **(#3)** view
fresca 7d → se a proof expira, load retorna zero sem erro → carteira zerada silenciosa (fail-open).

## Dados de produção (psql-ro, 2026-07-11) que re-enquadram o design

| Fato | Fonte | Consequência |
|---|---|---|
| Proof `omie_codigo_vendedor` = **100% NULL** (oben/colacor/colacor_sc), linhas frescas | `[1]` | Ponta 1 **não surtiu efeito** (edge não re-deployado/sync não rodou) → **dependência de sequência de deploy** |
| **Clones (1633) NÃO estão na proof** (sem document → nunca entram no document-first); só os gêmeos estão | `[3][6]` | Herança de vendedor via clone é **estruturalmente impossível** pela proof; lista **tem que** vir do espelho |
| Espelho tem os 1633 clones + 1633 gêmeos; proof oben (5238) ⊂ espelho (6909), 0 fora | `[6][7]` | Lista do espelho + vendedor da proof oben = herança intacta **e** cobertura preservada |
| `omie_clientes.empresa_omie` = **100% `'colacor'`** (default nunca populado) | `[8]` | Inútil p/ inferir conta nativa — a única fonte de conta é a proof |
| `omie_vendedor_map`: 18 códigos **disjuntos por conta**, 0 colisão, 0 user divergente | `[11][12][13]` | Load do map sem filtro é inequívoco; colisão futura → `computeCarteira` marca `conflict` (fail-safe) |
| Carteira hoje: 6909, 0 `source='omie'` (4797 Hunter visível + 2112 escondido) | `[9]` | 100% Hunter confirmado |

## Decisões travadas (com o founder, 2026-07-11)

1. **Cobertura: preservar 6909** (lista do espelho) — não encolher. Não-oben (1671) seguem Hunter
   visível, como hoje. **Sem delete.** → dissolve P1 #2 por construção.
2. **Guard tríplice fail-closed** (aborta se 0 vendedores) → P1 #3 + trava sequência de deploy.
3. **Oben estrito** — vendedor do cliente só de `account='oben'`; sem fallback proof colacor_sc.
4. (implícita) **vendedor_map inalterado** — sem filtro de conta (disjunto hoje; conflito futuro é fail-safe).

## Redesign — trocar a fonte do VENDEDOR, não da LISTA

`computeCarteira` (função pura, espelhada em `rebuild-helpers.ts` + edge) **permanece idêntica**. Muda
só o **LOAD** no handler `Deno.serve`:

- **Lista de membros:** continua `omie_clientes` (só `user_id`, paginado). Agrupamento canonical B-lite
  intacto — gêmeo + clones no mesmo grupo. **(resolve P1 #1)**
- **Vendedor:** lookup na view fresca `omie_customer_account_map_fresco` `account='oben'` →
  `Map<user_id, codigo>`. Para cada `user_id` do espelho: `omie_codigo_vendedor = proofOben.get(id) ?? null`.
  Gêmeo pega seu vendedor oben; clone (ausente da proof) → NULL → herda do gêmeo no grupo (eligible=false).
- **Reconciliação:** cobertura 6909→6909, todos recebem upsert → **zero stale** → upsert-only permanece
  adequado, **sem delete**. **(dissolve P1 #2)**
- **Guards fail-closed (P1 #3):**
  - `proofObenFresca.length === 0` → abortar
  - `proofObenFresca.length < 0.5 × espelho.length` → abortar (sync/TTL degradado; hoje 5238 vs piso 3454 → passa)
  - `comVendedor === 0` → abortar (ponta 1 não surtiu efeito / regressão; hoje 0 → abortaria, correto)
  - **pós-compute (rede de segurança):** 0 assignments `source='omie'` → abortar (nunca gravar carteira 100% Hunter)

  Todos análogos ao guard de `vendedor_map` vazio já existente (:155): erro → `fail()` **antes** de qualquer upsert.

## Mudanças de código

### `src/lib/carteira/rebuild-helpers.ts` (puro, testável — ADICIONAR)
- `coerceCodigoVendedor(raw: unknown): number | null` — bigint-safe (`Number.isSafeInteger` && `> 0`),
  simétrico à escrita da ponta 1 (PostgREST pode devolver bigint como number ou string).
- `montarClientes(espelhoIds: string[], proofOben: Map<string, number | null>): OmieClienteRow[]` —
  merge lista+vendedor (ordem/estabilidade preservada).
- `avaliarGuardProof(m: { espelho: number; proofFresca: number; comVendedor: number }): { abortar: boolean; motivo: string | null }`
  — os 3 thresholds pré-compute.
- **`computeCarteira` NÃO muda.**

### `supabase/functions/carteira-rebuild/index.ts` (edge — ESPELHAR + trocar load)
- Espelhar `coerceCodigoVendedor` / `montarClientes` / `avaliarGuardProof` (padrão MIRROR, "manter idêntico").
- Load novo: (a) espelho `omie_clientes(user_id)` paginado; (b) proof `omie_customer_account_map_fresco`
  `.eq('account','oben')` paginado → Map com `coerceCodigoVendedor`; (c) `avaliarGuardProof` → `fail()` se abortar;
  (d) `montarClientes` → `computeCarteira` (inalterado).
- Guard pós-compute (0 omie → `fail()`), atualizar header/comentários.

### Testes
- `rebuild-helpers.test.ts` — TDD das 3 funções novas + **falsificação** (proof vazia aborta; herança:
  clone ausente da proof herda do gêmeo; coerção rejeita bigint inseguro/≤0).
- `src/__tests__/edge-money-path-invariants.test.ts` — 4º guardrail: carteira-rebuild lê
  `omie_customer_account_map_fresco` `account='oben'` + paridade textual das funções espelhadas + guards presentes.

## Sequência de deploy (CRÍTICA — a proof está NULL hoje)

1. Deploy do edge **`omie-analytics-sync`** (ponta 1, #1293) no Lovable — se ainda não feito.
2. Sync de customers roda (ou forçar) → popula vendedor na proof oben (`com_vend > 0`).
3. Verificar (psql-ro) `com_vend > 0` em `account='oben'`.
4. **Só então** deploy do edge **`carteira-rebuild`** (esta ponta) + rodar.

O **guard de 0 vendedores torna a ordem segura**: se a ponta 2 for a produção antes da ponta 1 surtir
efeito, o rebuild **aborta** (fail-closed) e **preserva** a carteira atual — não a zera.

## Gate & verificação

- **Gate:** `bun run test` (rebuild-helpers + canário) · `deno check` do edge · `bun run typecheck` · `bun lint`.
- **/codex challenge** (`scripts/codex-async.sh -r xhigh`) do diff **antes** do PR (este edge bloqueou 2×).
- **Pós-deploy (psql-ro):** carteira ganha `source='omie'` (> 0) sem perder cobertura (6909 preservado);
  gêmeos com vendedor eligible=true; clones eligible=false; medir quantos gêmeos oben saem do Hunter.

## Rodada 2 — correções pós-Codex challenge R1 (8 P1 + 2 P2)

O Codex (gpt-5.6-sol, xhigh) achou que os guards v1 barravam só o caso **zero**, não a **regressão parcial**.
Correções (decisão do founder: guard **comparativo + operacional**):

| Achado Codex | Correção |
|---|---|
| **#3** guard pós contava inelegíveis | `omieElegivelNovo = rows.filter(source='omie' **&& eligible**)` — só elegível |
| **#4** denominador 50% = espelho misto | `avaliarGuardProof` compara `proofFresca` com a **proof oben CRUA** (mesma tabela, sem TTL) |
| **#1/#2** rollout/expiração parcial grava Hunters | **`avaliarGuardResultado`** (pós-compute): lê a carteira ATUAL (count omie-elegível) e aborta se cair `< 50%` (fator) do atual quando `atual > 100` (piso), além de `=== 0` sempre. 1º rebuild (atual=0) passa e é protegido **operacionalmente** (rodar só após proof completa via psql-ro) |
| **#7** presume `max_rows=1000` | Paginação robusta nos 2 loops: avança por `page.length` real, para na **página vazia**, guard `MAX_ROWS` |
| **P2** coerce lossy (hex/exp/`42.0…1`) | Só **decimal canônico** (`/^[0-9]+$/` + `BigInt ≤ 2^53`); number só via `Number.isSafeInteger && >0` |
| **P2** canário só helpers | Asserts de **wiring**: guards chamados (`guardPre/guardPos.abortar`), conta só `eligible`, lê carteira atual (`count:'exact'`), guard **antes do `.upsert(`** (`indexOf`) |

**Aceitos/pré-existentes (não introduzidos por esta ponta):** #5 stale por substituição de ID (upsert-only
sempre foi; founder decidiu sem delete; o guard comparativo pega regressões grandes) · #6 paginação
não-snapshot (padrão do edge; baixo risco na janela sync-05h × rebuild-07h30) · #8 concorrência entre
rebuilds (cron único + idempotente; advisory lock seria SQL novo, fora do escopo edge).

## Rodada 3 — Codex R2 ("não está fail-closed": bootstrap + catraca)

A R2 mostrou que o guard comparativo vs a carteira **atual** (baseline móvel) não protege: **bootstrap**
(`atual=0`, estado atual da produção) e **catraca** (4797→2399→1200, cada queda de 50% passa). E o **cron
`carteira-rebuild-nightly` está ATIVO (07:30 diário)** → a proteção operacional sozinha não basta.
Decisão do founder: **baseline persistido + bootstrap flag**.

- **Baseline saudável persistido** em `company_config.carteira_omie_baseline` (lido no início; gravado após
  rebuild bom como `max(baseline, novo)` — monotônico). O guard compara com `baselineEfetivo = max(persistido, atual)`,
  que **não desce sozinho** → catraca bloqueada. Fator **0.8** (queda >20% aborta).
- **Bootstrap bloqueado** por padrão: `baselineEfetivo === 0` sem `?bootstrap=1` → aborta. O **cron chama sem o
  param** → nunca faz bootstrap parcial. O 1º rebuild (e qualquer reset de queda legítima grande) é uma
  invocação manual explícita (`?bootstrap=1`), que rodo após confirmar a proof completa via psql-ro.
- **Cliff do piso 100 removido** (usa `baselineEfetivo`). **null-domain** no count cru (`.not('user_id','is',null)`).
- Persistência do baseline é **não-fatal** (a carteira já foi gravada) e mantém o cron **fail-closed** no próximo run.

**Ainda aceitos:** #8 concorrência + upserts em chunks não-atômicos (pré-existentes; cron único + idempotente).

## Rodada 4 — Codex R3 (fecha o fail-closed sob persistência-falha)

A R3 fechou a catraca sequencial, mas achou 2 P1: **(#1)** o check de bootstrap usava `baselineEfetivo = max(persistido, atual)`;
se a persistência do baseline falhasse após um bootstrap, o próximo cron veria `persistido=0, atual>0 → efetivo>0` e
**reabriria a catraca**. **(#2)** `?bootstrap=1` era override destrutivo para qualquer staff.

- **#1:** o guard compara **só com `baselinePersistido`** (removido o `atual` da lógica; a leitura da carteira atual saiu).
  Se a persistência falha, `baselinePersistido` segue 0 → o cron fica **fail-closed** (bootstrap bloqueado). É a garantia
  que a R3 provou faltar.
- **#2:** a flag só é honrada via **`service_role`/`cron`** (`auth.via`), não staff comum (employee comprometido não força bootstrap).
- **P2 parser:** `parseBaselineSaudavel` valida o valor lido (decimal canônico ≤ 2^53); corrompido → **aborta** (não vira `"4797lixo"→4797` / `"1e9"→1` / `Infinity`).
- **P2 aceitos:** lost-update do baseline (benigno — erra pro lado permissivo, nunca grava Hunter) · fator absoluto (maioria-Hunter = os não-oben aceitos; o baseline acompanha crescimento).

## Riscos aceitos

- **1671 não-oben seguem Hunter visível** (neutro; Hunter não é vendedor real, zero comissão). Limpeza = follow-up.
- **Gêmeo sem vendedor no cadastro oben** (se recomendações mora só no colacor_sc) → Hunter. Inevitável
  sob oben-estrito + clone-fora-da-proof; medido na verificação pós-deploy.
- **vendedor_map sem filtro de conta** — seguro por disjunção atual; colisão futura vira `conflict` (fail-safe).
- **1º rebuild pós-ponta-1** depende de proteção **operacional** (rodar após a proof oben estar completa —
  `com_vend` alto via psql-ro), pois o guard comparativo fica inativo com a carteira atual em 0 omie.
