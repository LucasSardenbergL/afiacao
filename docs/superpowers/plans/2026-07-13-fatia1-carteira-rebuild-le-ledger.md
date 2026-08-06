# Fatia 1 P0-B-bis — carteira-rebuild lê a LISTA do ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar a FONTE da LISTA de membros do `carteira-rebuild` de `omie_clientes` para `carteira_membership_ledger`, preservando cobertura (6909) e comportamento (paridade exata), sem tocar vendedor/guards/lógica pura.

**Architecture:** Mudança cirúrgica num único bloco de LOAD do edge (o handler `Deno.serve`, fora do bloco MIRROR). A lista passa a vir do ledger (acumulador append-only, população idêntica ao espelho hoje — diff simétrico 0/0). O guard textual (canário money-path) é atualizado test-first para exigir a nova fonte e barrar o retorno ao espelho. Helper puro e paridade MIRROR intactos.

**Tech Stack:** Supabase Edge (Deno, `@supabase/supabase-js`), vitest (canário textual em `src/__tests__`), TypeScript strict.

## Global Constraints

- **Idioma:** rotas/código/commits/PRs em pt-BR.
- **Money-path:** ausente ≠ zero; nunca fabricar número; guards fail-closed preservados.
- **Edge NÃO auto-deploya** no Lovable — merge na main ≠ produção; deploy manual no chat Lovable (verbatim do repo).
- **Sem SQL novo** nesta fatia → sem prove-sql PG17 (o ledger foi provado na Fatia 0).
- **Paridade edge↔helper:** o bloco `// MIRROR-START carteira-load` do edge deve permanecer textualmente idêntico ao de `src/lib/carteira/rebuild-helpers.ts` (comentários são normalizados fora na comparação — podem divergir).
- **/codex challenge** obrigatório antes do PR (money-path + este edge bloqueou 2×).
- **Épico QUENTE:** conferir `origin/main` + PRs antes de tocar `carteira-rebuild`/`rebuild-helpers` (feito: nenhum PR aberto toca esses arquivos).

---

## File Structure

- **Modify:** `supabase/functions/carteira-rebuild/index.ts` — bloco de LOAD da lista (:242-262), a chamada `montarClientes` (:303), o cabeçalho (:1-4). Troca a tabela; renomeia `espelhoIds`→`membroIds`; atualiza comentários.
- **Modify:** `src/__tests__/edge-money-path-invariants.test.ts` — no `describe` "carteira-rebuild lê o vendedor da PROOF oben (P0-B-bis ponta 2/2)": assert positivo (lista vem do ledger) + anti-reversão (não lê mais `omie_clientes`).
- **Modify (cosmético):** `src/lib/carteira/rebuild-helpers.ts` — comentário-header (:168) para refletir a nova fonte. Sem mudança de lógica.
- **Não toca:** vendedor (proof oben), `computeCarteira`, bloco MIRROR, guards, `rebuild-helpers.test.ts`.

---

### Task 1: carteira-rebuild lê a LISTA do ledger (canário test-first + edge)

**Files:**
- Modify: `src/__tests__/edge-money-path-invariants.test.ts` (describe da linha ~760)
- Modify: `supabase/functions/carteira-rebuild/index.ts:242-262, :303, :1-4`
- Modify: `src/lib/carteira/rebuild-helpers.ts:168` (comentário)

**Interfaces:**
- Consumes: tabela `public.carteira_membership_ledger(user_id uuid PK, ...)` (Fatia 0, já aplicada). PostgREST `.from('carteira_membership_ledger').select('user_id')`.
- Produces: nada novo para outras tasks (é a última desta fatia). O edge segue produzindo `carteira_assignments` idêntico.

- [ ] **Step 1: Atualizar o pré-requisito de contexto — atualizar o branch para origin/main**

O branch precisa conter o hotfix do canário (#1322, +10 linhas na região ai-ops) e os docs da Fatia 0 antes de editar. Fast-forward puro (0 commits próprios):

Run: `git merge --ff-only origin/main`
Expected: fast-forward até o topo de origin/main (inclui #1321/#1322). `git status` limpo.

- [ ] **Step 2: Escrever os asserts do canário (test-first)**

No arquivo `src/__tests__/edge-money-path-invariants.test.ts`, dentro do `describe('guardrail money-path: carteira-rebuild lê o vendedor da PROOF oben (P0-B-bis ponta 2/2)' ...)`, SUBSTITUIR o `it('anti-reversão: o load de omie_clientes NÃO tira mais o vendedor ...')` por estes dois testes:

```typescript
  it('A LISTA de membros vem do carteira_membership_ledger (Fatia 1 — não mais do espelho)', () => {
    expect(
      rebuild,
      'REVERSÃO Lovable? a LISTA de membros não vem mais do ledger — voltou ao espelho omie_clientes?',
    ).toMatch(/from\(['"]carteira_membership_ledger['"]\)[\s\S]{0,80}select\(['"]user_id['"]\)/);
  });

  it('anti-reversão: o carteira-rebuild NÃO lê mais omie_clientes em lugar nenhum (nem lista, nem vendedor)', () => {
    expect(
      rebuild,
      'REGRESSÃO: o carteira-rebuild voltou a ler o espelho poluído omie_clientes (lista ou vendedor)',
    ).not.toMatch(/from\(['"]omie_clientes['"]\)/);
  });
```

- [ ] **Step 3: Rodar o canário e verificar que FALHA**

Run: `heavy bun run test src/__tests__/edge-money-path-invariants.test.ts`
Expected: FALHA — o novo `it('A LISTA de membros vem do carteira_membership_ledger ...')` falha (o edge ainda lê `omie_clientes`), e o anti-reversão também falha (`omie_clientes` ainda presente). Prova que os asserts têm dente.

- [ ] **Step 4: Trocar a fonte da lista no edge**

Em `supabase/functions/carteira-rebuild/index.ts`, no bloco de LOAD (:242-262), substituir o comentário (:242-245) e o loop. Comentário novo:

```typescript
  // LISTA de membros = carteira_membership_ledger (P0-B-bis Fatia 1). Acumulador durável (append-only:
  // backfill + trigger AFTER INSERT no espelho; CASCADE só em delete de auth.users) → cobertura monotônica,
  // nunca encolhe → sem stale. Preserva a herança B-lite (gêmeo + clones) E a cobertura. O VENDEDOR vem da
  // proof oben (abaixo), não daqui. Paginação robusta a max_rows (#7 Codex): avança pela quantidade REAL
  // retornada e para na página VAZIA. Guard anti-loop MAX_ROWS. Sem filtro de identity_state (Fatia 2).
```

E o loop (o `user_id` do ledger é PK NOT NULL → o `.not('user_id','is',null)` do espelho vira morto e é removido):

```typescript
  const PAGE = 1000;
  const MAX_ROWS = 500_000;
  const membroIds: string[] = [];
  for (let from = 0; ;) {
    const { data, error } = await supabase
      .from('carteira_membership_ledger')
      .select('user_id')
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[carteira-rebuild] load ledger error:', error.message); return fail(error.message); }
    const page = (data ?? []) as Array<{ user_id: string }>;
    for (const r of page) membroIds.push(r.user_id);
    if (page.length === 0) break;
    from += page.length;
    if (from > MAX_ROWS) { console.error('[carteira-rebuild] ledger excedeu MAX_ROWS'); return fail('paginacao ledger excedeu limite'); }
  }
```

- [ ] **Step 5: Atualizar a chamada montarClientes e o cabeçalho do arquivo**

Na linha ~303, a variável renomeada: `const clientes = montarClientes(membroIds, proofOben);` (era `espelhoIds`). Atualizar o comentário :302 se mencionar espelho.

No cabeçalho (:2), trocar `LISTA de membros (omie_clientes)` por `LISTA de membros (carteira_membership_ledger)`. Atualizar as linhas :2-4 que descrevem o fluxo se citarem o espelho como fonte da lista.

Verificar que NÃO restou nenhuma outra referência a `omie_clientes` nem a `espelhoIds` no arquivo:

Run: `rg "omie_clientes|espelhoIds" supabase/functions/carteira-rebuild/index.ts`
Expected: nenhuma saída (zero ocorrências).

- [ ] **Step 6: Atualizar o comentário-header do helper (cosmético, não afeta paridade)**

Em `src/lib/carteira/rebuild-helpers.ts:168`, a linha que diz "A LISTA de membros continua vindo do espelho (preserva a herança B-lite...)" passa a: "A LISTA de membros vem do carteira_membership_ledger (Fatia 1; acumulador durável — preserva a herança B-lite: gêmeo + clones no mesmo grupo);". Comentário é normalizado fora na comparação de paridade → não quebra o MIRROR.

- [ ] **Step 7: Rodar o canário e verificar que PASSA**

Run: `heavy bun run test src/__tests__/edge-money-path-invariants.test.ts`
Expected: PASS — inclusive o `it('PARIDADE: as funções de load espelhadas são IDÊNTICAS ao src/ ...')` (o MIRROR não foi tocado) e os dois novos asserts.

- [ ] **Step 8: Rodar a suíte de carteira + gates estáticos**

Run: `heavy bun run test src/lib/carteira/`
Expected: PASS (rebuild-helpers inalterado — a lógica pura não mudou).

Run: `heavy bun run typecheck`
Expected: PASS (0 erros).

Run: `bun lint`
Expected: PASS.

- [ ] **Step 9: `deno check` do edge (o Deno não passa pelo tsc do src)**

Run: `deno check supabase/functions/carteira-rebuild/index.ts`
Expected: PASS. (Se `deno` não estiver instalado no ambiente, registrar e confiar no canário de paridade + typecheck do helper; anotar no PR.)

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/carteira-rebuild/index.ts src/lib/carteira/rebuild-helpers.ts src/__tests__/edge-money-path-invariants.test.ts docs/superpowers/specs/2026-07-13-fatia1-carteira-rebuild-le-ledger-design.md docs/superpowers/plans/2026-07-13-fatia1-carteira-rebuild-le-ledger.md
git commit -m "feat(carteira): Fatia 1 P0-B-bis — carteira-rebuild lê a LISTA do ledger

A LISTA de membros vem de carteira_membership_ledger (acumulador append-only)
em vez do espelho poluído omie_clientes. Vendedor/guards/lógica pura intactos;
paridade MIRROR preservada. População idêntica (diff 0/0) → paridade exata.
Quarantine (identity_state) fica para a Fatia 2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: /codex challenge do diff + abrir o PR

**Files:** nenhum (revisão + PR).

- [ ] **Step 1: Rodar o /codex challenge em background**

Money-path + este edge bloqueou 2× → revisão independente do diff antes do PR. Conduzir via wrapper assíncrono (nunca `codex exec` cru em foreground):

Run: `bash scripts/codex-async.sh -r xhigh` (com o diff da Task 1 como alvo — seguir a skill `/codex`)
Expected: parecer do Codex. Tratar cada P1/P2 (corrigir ou registrar como aceito com justificativa). O diff é pequeno (troca de fonte), mas o rótulo money-path exige o passo.

- [ ] **Step 2: Abrir o PR (não-draft → auto-merge no CI verde)**

```bash
git push -u origin claude/wizardly-varahamihira-90a6c6
gh pr create --title "feat(carteira): Fatia 1 P0-B-bis — carteira-rebuild lê a LISTA do ledger" --body "<corpo: contexto, decisão de escopo (quarantine→Fatia 2), validação, pendência de deploy do edge>"
```

- [ ] **Step 3: Armar o pr-watch em background**

Run: `bash scripts/pr-watch.sh <nº>` (run_in_background) → avisar no desfecho (mergeado/conflito/CI vermelho) via PushNotification.

---

## Deploy (pós-merge — pendências do founder)

- 💬 **chat Lovable:** deploy do edge `carteira-rebuild` (ler do repo, verbatim) — edge NÃO auto-deploya.
- ✅ **Migration:** nenhuma (Fatia 0 já aplicada).
- **Pós-deploy (Claude, psql-ro):** confirmar `source='omie'` ~2747 total / ~2728 elegíveis, cobertura 6909, `carteira_omie_baseline` = 2728. Reincidência do incidente 100% Hunter se congelar.

---

## Self-Review (plano × spec)

**1. Cobertura da spec:**
- §3.1 (troca da fonte no edge) → Task 1 Steps 4-5. ✅
- §3.2 (helper sem lógica, só comentário) → Task 1 Step 6. ✅
- §3.3 (canário: positivo + anti-reversão) → Task 1 Steps 2-3, 7. ✅
- §2 (sem filtro de identity_state) → comentário do Step 4 explicita "Sem filtro (Fatia 2)". ✅
- §5 (validação: vitest + typecheck + lint + deno check + codex + gate psql-ro) → Task 1 Steps 7-9, Task 2 Step 1, Deploy. ✅
- §4 (cobertura/guards preservados) → validado pelo gate psql-ro pós-deploy + guard baseline inalterado. ✅

**2. Placeholders:** o corpo do PR (Task 2 Step 2) é o único `<...>` — é conteúdo redacional a compor no momento, não código. Os asserts e o diff do edge estão completos e literais.

**3. Type consistency:** `membroIds: string[]` (renomeado de `espelhoIds`) usado no loop e em `montarClientes(membroIds, proofOben)`. `montarClientes(espelhoIds: string[], ...)` no helper mantém o nome do parâmetro (posicional na chamada — sem impacto). `page` tipado `Array<{ user_id: string }>` consistente com `.select('user_id')`.

## Execution Handoff

Escolha de execução após aprovação do plano (a Task 1 é única e coesa — inline com um checkpoint é o mais direto; subagent-driven alinha com o ritual da Fatia 0).
