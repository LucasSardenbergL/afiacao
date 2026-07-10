# PR-1 — `omie-sync` self-service: migrar leituras p/ view fresca + fallback fail-closed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** O `omie-sync` (pedido self-service, conta **colacor_sc**) resolve a identidade Omie do cliente/vendedor pela **view fresca account-correta** (`omie_customer_account_map_fresco`) + **fallback API fail-closed** em doc-ambíguo, parando de ler o espelho poluído `omie_clientes`.

**Architecture:** Trazer para o `omie-sync` o padrão **já provado** no `omie-vendas-sync` (P0-B): leitura por `(user_id, account)` na fonte account-correta → ausência → `ListarClientes` com `registros_por_pagina:2` (detecta duplicata-CNPJ) → **fail-closed** se ambíguo. Encapsular a decisão num **helper puro** em `src/lib/omie/` (testável no vitest), espelhado verbatim no edge (`MIRROR-START/END`, paridade textual no CI — padrão do repo, ver `omie-doc-ambiguo.ts`).

**Tech Stack:** Deno edge function + `@supabase/supabase-js` + vitest.

## Global Constraints (verbatim do spec `2026-07-09-omie-leituras-money-path-p0b-bis-design.md`)

- Fonte = view **`omie_customer_account_map_fresco`**, NUNCA a tabela base (Codex P1: base = stale infinito).
- Conta do fluxo = **`colacor_sc`** (`OMIE_COLACOR_SC_APP_KEY`, omie-sync:99).
- Fallback API **fail-closed**: `registros_por_pagina >= 2` + rejeitar 2+ códigos distintos no mesmo doc (Codex P1: `registros:1` é last-write-wins).
- **Nunca** ler `omie_clientes` no caminho money-path do omie-sync.
- Helper puro em `src/lib/omie/` + espelho verbatim no edge (MIRROR); paridade no CI.
- **Pré-condição de rollout:** [#1272](../../../) (P1b re-aplicado) **deployado** pelo founder + 1 run do sync (proof não-ambígua) ANTES do deploy desta PR.

---

### Task 1: Helper puro `resolveIdentidadeColacorSc` (view fresca → decisão)

**Files:**
- Create: `src/lib/omie/omie-sync-identidade.ts`
- Test: `src/lib/omie/omie-sync-identidade.test.ts`

**Interfaces:**
- Produces: `type MatchOmie = { codigo_cliente: number; codigo_vendedor: number | null }` · `decidirIdentidadeSelfService(args: { viewRow: MatchOmie | null; omieMatches: MatchOmie[] | null }): { ok: true; codigo_cliente: number; codigo_vendedor: number | null } | { ok: false; needOmie: true } | { ok: false; erro: string }`
- Contrato: `viewRow` presente → `ok` com o código da view. `viewRow` null e `omieMatches` null → `needOmie` (chamador busca a API). `omieMatches` com **≥2 códigos distintos** → `{ ok:false, erro:'doc-ambíguo' }` (fail-closed). `omieMatches` com exatamente 1 → `ok`. `omieMatches` vazio → `{ ok:false, erro:'sem-vinculo' }`.

- [ ] **Step 1: escrever os testes falhando** (casos: view presente → ok; view null → needOmie; 1 match → ok; 2 matches códigos distintos → erro doc-ambíguo; 2 matches MESMO código → ok; 0 matches → sem-vinculo; falsificação: helper que ignora ambiguidade → teste vermelho).
- [ ] **Step 2: rodar `bun run test src/lib/omie/omie-sync-identidade.test.ts` → FAIL** (função indefinida).
- [ ] **Step 3: implementar `decidirIdentidadeSelfService`** — pura, sem I/O. Dedup de `omieMatches` por `codigo_cliente`; `size>1` → erro.
- [ ] **Step 4: rodar o teste → PASS.**
- [ ] **Step 5: commit** (`test+feat(omie-sync): helper puro de identidade self-service account-correta`).

> **Reuso:** a semântica de "2+ códigos distintos = ambíguo" espelha `docsComCodigoAmbiguoNoOmie` (`src/lib/omie/omie-doc-ambiguo.ts`) e a de matches espelha `buscarClienteVendasMatches` (omie-vendas-sync:1637). Manter os nomes/formatos alinhados.

---

### Task 2: Edge — leitura da view fresca + fallback API 2+ (o call-site do PEDIDO, omie-sync:236)

**Files:**
- Modify: `supabase/functions/omie-sync/index.ts` (a função de resolver cliente p/ pedido, hoje :227-290)

**Interfaces:**
- Consumes: `decidirIdentidadeSelfService` (Task 1), espelhado no edge via bloco `MIRROR-START omie-sync-identidade … MIRROR-END`.

- [ ] **Step 1:** substituir a leitura `omie_clientes` (:236-240) por: `supabase.from('omie_customer_account_map_fresco').select('omie_codigo_cliente, omie_codigo_vendedor').eq('user_id', userId).eq('account','colacor_sc').maybeSingle()`.
- [ ] **Step 2:** substituir o fallback `registros_por_pagina:1` (:257) por `registros_por_pagina:2` e mapear `clientes_cadastro` → `MatchOmie[]`; passar a `decidirIdentidadeSelfService`.
- [ ] **Step 3:** no ramo `erro:'doc-ambíguo'` → lançar `Error` com mensagem clara ("CNPJ com 2+ cadastros na conta colacor_sc — cadastro ambíguo, pedido bloqueado") — fail-closed, NÃO grava.
- [ ] **Step 4:** espelhar o helper como bloco MIRROR verbatim no topo do edge.
- [ ] **Step 5:** manter o write-back (:284) por ora (é writer → Fatia 4); adicionar comentário `// TODO Fatia 4: write-back no espelho`.
- [ ] **Step 6:** `bun run typecheck` → PASS.
- [ ] **Step 7: commit.**

---

### Task 3: Edge — call-sites de vendedor (:786) e check_client (:981)

**Files:**
- Modify: `supabase/functions/omie-sync/index.ts:~786, ~981`

- [ ] **Step 1:** `:786` (fallback vendedor) — trocar leitura do espelho por `omie_customer_account_map_fresco` `.eq('account','colacor_sc')` (`omie_codigo_vendedor`).
- [ ] **Step 2:** `:981` (`check_client`) — idem; ausência na view → buscar API 2+ fail-closed (reusar Task 1) OU retornar "não encontrado" honesto (definir na execução conforme o contrato atual do `check_client`).
- [ ] **Step 3:** `bun run typecheck` → PASS.
- [ ] **Step 4: commit.**

---

### Task 4: Canário anti-reversão-Lovable + gate

**Files:**
- Modify: `src/__tests__/edge-money-path-invariants.test.ts`

- [ ] **Step 1:** adicionar asserts textuais no edge `omie-sync`: (a) usa `omie_customer_account_map_fresco` (não `omie_clientes`) no caminho de pedido; (b) fallback usa `registros_por_pagina` ≥ 2 (não 1); (c) bloco MIRROR do helper presente e idêntico ao `src/`.
- [ ] **Step 2:** rodar `bun run test src/__tests__/edge-money-path-invariants.test.ts` → PASS.
- [ ] **Step 3:** rodar suíte relevante + `bun run typecheck` + `bun run lint` → PASS.
- [ ] **Step 4: commit.**

---

### Task 5: /codex challenge do diff + PR

- [ ] **Step 1:** `/codex challenge` do diff (money-path) via `scripts/codex-async.sh -r xhigh` — focar: o fail-closed cobre o caso "view stale + código mudou de dono <7d"? o write-back (:284) intocado causa incoerência? Incorporar achados.
- [ ] **Step 2:** abrir PR com corpo incluindo o **passo de deploy do founder** (edge `omie-sync` verbatim no Lovable — mesma armadilha do #1272) + validação psql-ro (outcomes não regridem).
- [ ] **Step 3:** `scripts/pr-watch.sh <nº>` em background.

---

## Gate (resumo)

vitest (helper +/- com falsificação) · canário textual (anti-reversão) · typecheck · lint · /codex challenge do diff. **Sem prove-sql** (PR-1 é edge TS puro, sem SQL/constraint nova). **Deploy:** edge `omie-sync` pelo chat do Lovable (verbatim) + verificar anti-reversão + validar (psql-ro) que o pedido self-service resolve pela view.

## Riscos / notas de execução

- **Reler o `omie-sync` atual no momento da execução** — os números de linha (:236/:786/:981) são do estado 2026-07-09; podem ter mudado.
- **Não migrar o write-back (:284)** nesta PR — é writer (Fatia 4). Só a LEITURA migra.
- **check_client (:981):** confirmar o contrato atual (o que o frontend espera) antes de trocar a semântica de ausência.
- **Fora desta PR** (spec §4 FORA): guard `codeBelongsToWrongAccount` e bug semântico do `ai-ops-agent`.
