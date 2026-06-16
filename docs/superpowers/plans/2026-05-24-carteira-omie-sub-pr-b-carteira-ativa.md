# Carteira-Omie — Sub-PR B (Carteira ativa: scores por dono + cobertura) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Fazer a tela do vendedor consumir a carteira inteira do Omie — o scoring passa a cobrir **todos** os clientes da carteira (`farmer_id = dono`, não mais "quem teve atividade"), e as leituras ganham cobertura de férias.

**Architecture (Opção A — 2º codex consult):** NÃO dropar `farmer_id`; redefini-lo como "dono da carteira". O seed do `calculate-scores` (que já varre o universo todo em memória) passa a usar `carteira_assignments.owner_user_id`. A unique das tabelas de score vira `customer_user_id` (1 linha por cliente, sem migração destrutiva de coluna). Leituras (`eq('farmer_id', eu)`) já significam "minha carteira"; cobertura expande pra `farmer_id IN [eu, ...donos cobertos]`.

**Tech Stack:** Supabase Postgres (migration manual Lovable), Deno edge functions (deploy via chat Lovable), React + Vitest.

**Spec:** `docs/superpowers/specs/2026-05-23-carteira-omie-fonte-verdade-design.md` (seção "Scores — farmer_id redefinido = dono").
**Pré-requisito:** PR #236 (Sub-PR A) mergeado no `main`. ✅ MERGEADO.

---

## ✅ CONCLUÍDO — Sub-PR B mergeada e rollout VALIDADO em produção (2026-05-25)

**PR #263 mergeada** na `main` (squash, commit `7ac27cc`). Rollout coordenado aplicado e validado no Lovable. **#236** (Sub-PR A, Posse) também em produção.

**Código completo (commitado + pushado, test 835✓ / typecheck:strict✓):**
- ✅ **Task 1** — `20260524170000_scores_unique_por_cliente.sql`: dedupe por **RIQUEZA** (não ctid — codex pegou que linhas do recalc têm colunas ricas nulas) + UNIQUE(customer_user_id).
- ✅ **Task 2** — `src/lib/carteira/owner-map.ts` + testes (anti-drift).
- ✅ **Task 3** — `calculate-scores` seeda farmer_id=dono + onConflict por cliente.
- ✅ **Task 4** — 4 recalc functions: onConflict 'customer_user_id'; visit lê fcs por customer_user_id; **drain concorrente**; batch enumera só ativos (30d) mapeados pro dono. + nova migration `20260524180000_carteira_scores_owner_e_filas.sql` (UPDATE owner set-based + INSERT faltantes + índice de fila (customer_user_id) + 3 triggers resolvendo dono via carteira_assignments).
- ✅ **Task 5** — `useCoverage` (tipado) + `useMyVisitSuggestions`/`useMyCarteiraScores` (`in('farmer_id', [eu,...cobertos])` + `coberto_de`).
- ✅ **Task 6** — `CoveragePanel` em /settings + selo no `VisitSuggestionsCard`.

**Decisões-chave (codex consult 2026-05-24, sessão da continuação):**
- `calculate-scores` só seeda em tabela VAZIA → reconciliação de farmer_id=dono é **SQL set-based** (preserva colunas ricas), não via calculate-scores.
- Backfill de visit score dos 6908 = **fila como cursor** + **drain concorrente** (não fan-out, não offset). Enfileira tudo via SQL, dreno ~14x.
- Triggers de fila enfileiravam pelo ATOR → resolvem o dono via `carteira_assignments` (COALESCE).
- Divergência spec×codex: mantido `signal_modifiers` das ligações DO DONO (spec).

**✅ ROLLOUT EXECUTADO E VALIDADO (2026-05-25, via SQL Editor + chat do Lovable):**
1. ✅ BLOCO A (`20260524170000`) → `uniques=2`
2. ✅ BLOCO B (`20260524180000`) → 6908 linhas, 6908 com dono certo, filas_uniq=2
3. ✅ Re-deploy das 5 functions (Active)
4. ✅ `calculate-scores` → "Scores calculated for 6908 clients"
5. ✅ BLOCO C (enfileira) → 6908 pendentes
6. ✅ Drain concorrente do `visit-score-recalc-client` (`max_drain:1000`, ~7x) → fila 6908→0
7. ✅ `scoring-recalc-batch` → recalculated:0 (sem atividade nos últimos 30d agora; normal)
8. ✅ **BLOCO D**: `farmer_client_scores` e `customer_visit_scores` = **6908 linhas / 6908 clientes** cada, **3 donos**, **Regina = 1890**, **fila_pendente = 0**
9. ✅ Crons `scoring-recalc-batch-nightly` (`0 6 * * *`) e `visit-score-recalc-batch-nightly` (`0 7 * * *`) ativos, rodando o código novo

**Pendências não-bloqueantes:** smoke test no app (vendedor vê carteira completa + selo de cobertura); flaky test `ContasPagarTab` (test-pollution da main, tarefa separada); worktree principal com `feat` local atrás do remoto + `ProcessoComprasStepper.tsx` não-commitado.

---

---

## Pré-requisitos operacionais
- DB só via Lovable SQL Editor (migration manual, 1 bloco/mensagem, validação no fim).
- Edge functions deployadas via chat do Lovable (EDIT de função existente → colar código; funções são grandes, então o implementador edita o arquivo do repo e entrega o conteúdo final pro chat).
- `bun run test` (vitest) é canônico.
- **Anti-drift (regra do codex):** nenhuma lógica pode voltar a seedar score por "atividade". O score vem de `carteira_assignments`. Travado por comentário + teste (Task 2).

## File Structure

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/<ts>_scores_unique_por_cliente.sql` (criar) | Dedupe + troca UNIQUE(customer,farmer)→UNIQUE(customer_user_id) nas 2 tabelas de score; recria índices. |
| `src/lib/carteira/owner-map.ts` + `__tests__/` (criar) | Helper puro `buildOwnerMap(assignments)` → `Map<customer_user_id, owner_user_id>` + `resolveOwner(map, customer, fallback)`. Reusado/espelhado nas edge functions. |
| `supabase/functions/calculate-scores/index.ts` (modificar) | Seed usa `carteira_assignments.owner_user_id` como `farmer_id` (não `defaultFarmerId`); `onConflict: 'customer_user_id'`. |
| `supabase/functions/scoring-recalc-client/index.ts` (modificar) | Upsert `onConflict: 'customer_user_id'`; `farmer_id` = dono da carteira do cliente (não da fila de atividade). |
| `supabase/functions/scoring-recalc-batch/index.ts` (modificar) | Enumerar `carteira_assignments` (não `farmer_calls`). |
| `supabase/functions/visit-score-recalc-client/index.ts` (modificar) | Ler `farmer_client_scores` por `customer_user_id`; upsert `onConflict: 'customer_user_id'`. |
| `supabase/functions/visit-score-recalc-batch/index.ts` (modificar) | Enumerar `carteira_assignments`. |
| `src/hooks/useCoverage.ts` (criar) | `useMyActiveCoverage()` → lista de `covered_user_id` que EU cubro agora; `useCreateCoverage()`/`useEndCoverage()` (master ou dono coberto). |
| `src/hooks/useMyVisitSuggestions.ts` (modificar) | Filtro `eq('farmer_id', uid)` → `in('farmer_id', [uid, ...coberto])`; anexar flag de cobertura. |
| `src/hooks/useMyCarteiraScores.ts` (modificar) | Mesmo: `in('farmer_id', [uid, ...coberto])`. |
| `src/components/carteira/CoveragePanel.tsx` (criar) | UI mínima de cobertura (criar/encerrar) — em `/settings` ou página admin. |

---

## Task 1: Migration — unique por cliente nas tabelas de score

**Files:** Create `supabase/migrations/20260524160000_scores_unique_por_cliente.sql`

> Com `farmer_id` redefinido como dono, cada cliente tem 1 linha. Trocar a UNIQUE evita duplicatas quando o dono muda. Dedupe primeiro (mantém a linha mais recente por cliente).

- [ ] **Step 1: Escrever a migration**

```sql
-- 20260524160000_scores_unique_por_cliente.sql
-- Opção A: score é 1 por cliente (farmer_id = dono). Troca UNIQUE(customer,farmer)→UNIQUE(customer).

-- 1. farmer_client_scores: dedupe mantendo a linha mais recente por cliente
DELETE FROM public.farmer_client_scores a
USING public.farmer_client_scores b
WHERE a.customer_user_id = b.customer_user_id
  AND a.ctid < b.ctid;  -- mantém uma; valores serão recomputados pelo calculate-scores

ALTER TABLE public.farmer_client_scores DROP CONSTRAINT IF EXISTS farmer_client_scores_customer_user_id_farmer_id_key;
ALTER TABLE public.farmer_client_scores ADD CONSTRAINT farmer_client_scores_customer_unique UNIQUE (customer_user_id);

-- 2. customer_visit_scores: idem
DELETE FROM public.customer_visit_scores a
USING public.customer_visit_scores b
WHERE a.customer_user_id = b.customer_user_id
  AND a.ctid < b.ctid;

ALTER TABLE public.customer_visit_scores DROP CONSTRAINT IF EXISTS customer_visit_scores_customer_user_id_farmer_id_key;
ALTER TABLE public.customer_visit_scores ADD CONSTRAINT customer_visit_scores_customer_unique UNIQUE (customer_user_id);

-- 3. Índices de leitura continuam úteis (farmer_id = dono); adiciona um por cliente p/ join.
CREATE INDEX IF NOT EXISTS idx_fcs_customer ON public.farmer_client_scores (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_cvs_customer ON public.customer_visit_scores (customer_user_id);

SELECT 'BLOCO SCORES UNIQUE OK' AS status,
  (SELECT count(*) FROM pg_constraint WHERE conname IN
     ('farmer_client_scores_customer_unique','customer_visit_scores_customer_unique')) AS uniques;
```

> ⚠️ **Confirmar o nome real das constraints antigas** antes de entregar: rodar no Lovable `SELECT conname FROM pg_constraint WHERE conrelid='public.farmer_client_scores'::regclass;`. Ajustar o `DROP CONSTRAINT IF EXISTS` ao nome real (o nome auto-gerado costuma ser `<tabela>_customer_user_id_farmer_id_key`).

- [ ] **Step 2: Commit + entregar SQL pro Lovable**

```bash
git add supabase/migrations/20260524160000_scores_unique_por_cliente.sql
git commit -m "feat(carteira): scores unique por cliente (Opção A, farmer_id=dono)"
```
Entregar como BLOCO no chat; esperado `BLOCO SCORES UNIQUE OK | uniques=2`.

---

## Task 2: Helper puro owner-map + teste anti-drift (TDD)

**Files:** Create `src/lib/carteira/owner-map.ts` + `src/lib/carteira/__tests__/owner-map.test.ts`

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/carteira/__tests__/owner-map.test.ts
import { describe, it, expect } from 'vitest';
import { buildOwnerMap, resolveOwner } from '../owner-map';

describe('owner-map (anti-drift: score vem da carteira, não de atividade)', () => {
  it('buildOwnerMap monta customer→owner', () => {
    const m = buildOwnerMap([
      { customer_user_id: 'c1', owner_user_id: 'regina' },
      { customer_user_id: 'c2', owner_user_id: 'tati' },
    ]);
    expect(m.get('c1')).toBe('regina');
    expect(m.get('c2')).toBe('tati');
  });
  it('resolveOwner usa a carteira; fallback só se cliente não estiver na carteira', () => {
    const m = buildOwnerMap([{ customer_user_id: 'c1', owner_user_id: 'regina' }]);
    expect(resolveOwner(m, 'c1', 'hunter')).toBe('regina');
    expect(resolveOwner(m, 'desconhecido', 'hunter')).toBe('hunter');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test src/lib/carteira/__tests__/owner-map.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

```ts
// src/lib/carteira/owner-map.ts
export interface AssignmentRow { customer_user_id: string; owner_user_id: string; }

/** customer_user_id → owner_user_id (dono da carteira). Fonte de verdade do score (Opção A). */
export function buildOwnerMap(assignments: AssignmentRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of assignments) m.set(a.customer_user_id, a.owner_user_id);
  return m;
}

/** Resolve o dono de um cliente; fallback (ex.: Hunter) só se o cliente não estiver na carteira. */
export function resolveOwner(map: Map<string, string>, customerUserId: string, fallback: string | null): string | null {
  return map.get(customerUserId) ?? fallback;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test src/lib/carteira/__tests__/owner-map.test.ts` → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/carteira/owner-map.ts src/lib/carteira/__tests__/owner-map.test.ts
git commit -m "feat(carteira): helper owner-map (score por dono, anti-drift) + testes"
```

---

## Task 3: `calculate-scores` — seed pelo dono da carteira

**Files:** Modify `supabase/functions/calculate-scores/index.ts`

> O implementador DEVE ler o arquivo atual (493 linhas) antes de editar. As mudanças são pontuais e descritas abaixo com o código exato.

Contexto do arquivo (confirmado por leitura): há um caminho de **seed** que pagina `omie_clientes`, computa snapshots RFM de `order_items`, e monta `seedRecords` com `farmer_id: defaultFarmerId` (≈ linha 275), fazendo `upsert(..., { onConflict: 'customer_user_id,farmer_id' })` (≈ linhas 303 e 312). Depois recomputa scores e faz `upsert` final (≈ linha 466) com `farmer_id: client.farmer_id` (linhas 439/452).

- [ ] **Step 1: Carregar a carteira (owner map) antes do seed**

Logo após obter `allClients` (lista paginada de `omie_clientes`, ≈ linha 210) e ANTES de montar `seedRecords`, adicionar a leitura paginada de `carteira_assignments` e montar o mapa:

```ts
    // Opção A: dono do score = dono da carteira (carteira_assignments), não defaultFarmerId.
    const ownerMap = new Map<string, string>();
    for (let page = 0; ; page++) {
      const { data: aPage } = await supabase
        .from('carteira_assignments')
        .select('customer_user_id, owner_user_id')
        .range(page * 1000, page * 1000 + 999);
      const rows = (aPage ?? []) as Array<{ customer_user_id: string; owner_user_id: string }>;
      for (const r of rows) ownerMap.set(r.customer_user_id, r.owner_user_id);
      if (rows.length < 1000) break;
    }
```

- [ ] **Step 2: Usar o dono no seed**

Na montagem de cada `seedRecords.push({ ... farmer_id: defaultFarmerId, ... })`, trocar `farmer_id: defaultFarmerId` por:

```ts
        farmer_id: ownerMap.get(<customerUserId da iteração>) ?? defaultFarmerId,
```
(usar o nome real da variável do customer_user_id no loop — conferir no arquivo).

- [ ] **Step 3: Trocar o onConflict para customer_user_id**

Em TODAS as chamadas `upsert(..., { onConflict: 'customer_user_id,farmer_id' })` deste arquivo (seed em lote, seed individual no catch, e o upsert final de scores ≈ linha 466), trocar para `{ onConflict: 'customer_user_id' }`. Isso casa com a nova UNIQUE (Task 1) e, se o dono mudar, ATUALIZA a linha (em vez de duplicar).

- [ ] **Step 4: Comentário anti-drift**

No topo da função, adicionar:
```ts
// ANTI-DRIFT (carteira-Omie Opção A): o "dono" do score (farmer_id) vem SEMPRE de
// carteira_assignments.owner_user_id — NUNCA de atividade (farmer_calls/route_visits).
```

- [ ] **Step 5: Commit + deploy**

```bash
git add supabase/functions/calculate-scores/index.ts
git commit -m "feat(carteira): calculate-scores seeda farmer_id=dono da carteira (Opção A)"
```
Deploy: entregar o conteúdo final do arquivo pro chat do Lovable (EDIT da função `calculate-scores`).

---

## Task 4: Recalc functions — enumerar carteira + onConflict por cliente

**Files:** Modify `scoring-recalc-batch`, `scoring-recalc-client`, `visit-score-recalc-batch`, `visit-score-recalc-client` (todos em `supabase/functions/.../index.ts`).

> Implementador lê cada arquivo antes de editar. Mudanças descritas com código exato.

> ⚠️ **NUANCE CRÍTICA (parte mais delicada do Sub-PR B — fazer com cuidado):**
> 1. **Full refresh já é do `calculate-scores`** (Task 3, feito). Pra evitar timeout de 50s, o `scoring-recalc-batch` **NÃO deve** fazer fan-out por cliente sobre os ~6908 da carteira. Decisão recomendada: `scoring-recalc-batch` mantém **só o drain da fila incremental**; o full refresh fica com o `calculate-scores`. (O `visit-score-recalc-batch` pode enumerar a carteira pois é mais leve — medir; se estourar, idem: delegar full refresh e só drenar fila.)
> 2. **`farmer_id` = DONO, sempre.** Em `scoring-recalc-client`/`visit-score-recalc-client`, ao processar um cliente, resolver o dono via `carteira_assignments` (não confiar no `farmer_id` que veio da fila/atividade). Upsert `onConflict: 'customer_user_id'`.
> 3. **`signal_modifiers` = ligações DO DONO.** Em `scoring-recalc-client`, o `.eq('farmer_id', X)` em `farmer_calls` deve usar X = **dono** (não quem ligou). Cobertura é visibilidade, não muda atribuição (decisão codex).
> 4. **Triggers/fila:** os triggers que enfileiram recalc usam o `farmer_id` da atividade (ex.: `enqueue ... from_visit` usa `NEW.visited_by`; o de `farmer_calls` usa o caller). Sob a Opção A, o que importa é o **cliente** (o dono é resolvido no recalc). Avaliar: (a) deixar a fila enfileirar por cliente e o recalc-client resolver o dono (mais simples), ou (b) o trigger já resolver o dono. Preferir (a). **Cuidado** com a unique parcial da fila `(customer_user_id, farmer_id) WHERE processed_at IS NULL` — se a fila virar por-cliente, ajustar pra `(customer_user_id)`. Mapear isso ao editar os triggers (migration adicional pequena pode ser necessária).

- [ ] **Step 1: `scoring-recalc-batch` — enumerar carteira (não farmer_calls)**

Hoje monta pares únicos de `farmer_calls` (últimos 30d). Trocar a enumeração por `carteira_assignments` paginado (mesmo padrão de paginação da Task 3), gerando pares `{ customer_user_id, farmer_id: owner_user_id }`. Manter o drain da fila como está.

```ts
  // Opção A: full refresh enumera a carteira inteira (não atividade).
  const pairs: Array<{ customer_user_id: string; farmer_id: string }> = [];
  for (let page = 0; ; page++) {
    const { data } = await supabase.from('carteira_assignments')
      .select('customer_user_id, owner_user_id')
      .range(page * 1000, page * 1000 + 999);
    const rows = (data ?? []) as Array<{ customer_user_id: string; owner_user_id: string }>;
    for (const r of rows) pairs.push({ customer_user_id: r.customer_user_id, farmer_id: r.owner_user_id });
    if (rows.length < 1000) break;
  }
```
> ⚠️ Volume: ~6908 pares com fan-out CONCURRENCY=10 pode estourar 50s. Se estourar, NÃO fan-out por cliente — delegar o full-refresh ao `calculate-scores` (que já roda em memória) e deixar o batch só drenando a fila incremental. Decisão de implementação: medir; preferir chamar `calculate-scores` uma vez para o full refresh e manter o `scoring-recalc-batch` só para a fila.

- [ ] **Step 2: `scoring-recalc-client` — upsert por cliente + farmer_id=dono**

Trocar `upsert(..., { onConflict: 'customer_user_id,farmer_id' })` por `{ onConflict: 'customer_user_id' }`. O `farmer_id` gravado deve ser o dono da carteira do cliente (já vem no par do batch). O filtro de `farmer_calls` para `signal_modifiers` continua `.eq('farmer_id', <dono>)` — ou seja, ligações DO DONO (decisão codex: cobertura é visibilidade, não muda atribuição).

- [ ] **Step 3: `visit-score-recalc-client` — ler fcs por cliente + upsert por cliente**

A leitura de `farmer_client_scores` muda de `.eq('farmer_id', farmer_id)` para `.eq('customer_user_id', customer_user_id)` (agora há 1 linha por cliente). Upsert de `customer_visit_scores` → `{ onConflict: 'customer_user_id' }`, `farmer_id` = dono.

- [ ] **Step 4: `visit-score-recalc-batch` — enumerar carteira**

Mesma troca do Step 1 (enumerar `carteira_assignments` em vez de `farmer_calls ∪ route_visits`).

- [ ] **Step 5: Commits + deploy**

Um commit por função (4 commits) e deploy de cada via chat do Lovable (EDIT). Mensagens no formato `feat(carteira): <fn> enumera carteira + onConflict customer_user_id`.

---

## Task 5: Hook de cobertura + leituras com expansão

**Files:** Create `src/hooks/useCoverage.ts`; Modify `src/hooks/useMyVisitSuggestions.ts`, `src/hooks/useMyCarteiraScores.ts`.

- [ ] **Step 1: Criar `useCoverage.ts`**

```ts
// src/hooks/useCoverage.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

/** user_ids cujas carteiras EU cubro agora (cobertura ativa e dentro da validade). */
export function useMyActiveCoverage() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-active-coverage', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<string[]> => {
      if (!user) return [];
      const nowIso = new Date().toISOString();
      const { data, error } = await (supabase as any).from('carteira_coverage')
        .select('covered_user_id, valid_until, active')
        .eq('covering_user_id', user.id)
        .eq('active', true);
      if (error) throw error;
      return ((data ?? []) as Array<{ covered_user_id: string; valid_until: string | null }>)
        .filter((c) => !c.valid_until || c.valid_until > nowIso)
        .map((c) => c.covered_user_id);
    },
  });
}

export function useCreateCoverage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { covering_user_id: string; covered_user_id: string; valid_until: string | null }) => {
      const { error } = await (supabase as any).from('carteira_coverage').insert({
        covering_user_id: input.covering_user_id,
        covered_user_id: input.covered_user_id,
        valid_until: input.valid_until,
        active: true,
        created_by: user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-active-coverage'] }),
  });
}

export function useEndCoverage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (coverageId: string) => {
      const { error } = await (supabase as any).from('carteira_coverage')
        .update({ active: false }).eq('id', coverageId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-active-coverage'] }),
  });
}
```
> A UI (Task 6) coleta `covering_user_id` (quem cobre) e `covered_user_id` (quem está de férias) explicitamente. A RLS (Task 1 do Sub-PR A) já garante que só master ou o próprio coberto pode inserir.

- [ ] **Step 2: `useMyVisitSuggestions` — expandir filtro**

As duas queries em `customer_visit_scores` trocam `.eq('farmer_id', userId)` por `.in('farmer_id', ownerIds)`, onde `ownerIds = [userId, ...covered]` (vindo de `useMyActiveCoverage`). Anexar em cada sugestão um campo `coberto_de: string | null` = o `farmer_id` da linha quando ≠ `userId` (resolver o nome via profiles no componente). Manter `pickDailyMix` inalterado.

- [ ] **Step 3: `useMyCarteiraScores` — expandir filtro**

Trocar `.eq('farmer_id', user.id)` por `.in('farmer_id', ownerIds)`.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useCoverage.ts src/hooks/useMyVisitSuggestions.ts src/hooks/useMyCarteiraScores.ts
git commit -m "feat(carteira): leituras expandem p/ cobertura ativa + selo coberto_de"
```

---

## Task 6: UI de cobertura + selo + recompute + validação + PR

**Files:** Create `src/components/carteira/CoveragePanel.tsx`; Modify a página de destino (ex.: `src/pages/Settings.tsx` ou painel admin) + o componente que renderiza sugestões (`VisitSuggestionsCard`) p/ o selo.

- [ ] **Step 1: `CoveragePanel.tsx`** — formulário: seleciona `covered_user_id` (quem está de férias) e `valid_until`; lista coberturas ativas com botão "encerrar". Gate: visível só pra master OU pro próprio dono coberto (usar `useAccess().persona === 'gestao'` ou `user.id === covered`). Usa `useCreateCoverage`/`useEndCoverage`.

- [ ] **Step 2: Selo no `VisitSuggestionsCard`** — quando `suggestion.coberto_de` != null, mostrar badge "Cobertura — {nome}" (status-color, ver §4 do CLAUDE.md; usar `text-status-*`).

- [ ] **Step 3: Recompute em produção** — após deploy das functions (Tasks 3-4), pedir ao chat do Lovable: "invoque `calculate-scores` e mostre a resposta" (recomputa todos os clientes com farmer_id=dono). Depois invocar `visit-score-recalc-batch`.

- [ ] **Step 4: Validar (SQL Editor)**

```sql
SELECT 'SCORES POR DONO' AS t,
  count(*) AS linhas,
  count(DISTINCT customer_user_id) AS clientes_distintos,
  count(DISTINCT farmer_id) AS donos
FROM public.farmer_client_scores;
-- esperado: linhas == clientes_distintos (1 por cliente); donos ~3
```
E conferir que a carteira da Regina tem score:
```sql
SELECT count(*) FROM public.farmer_client_scores
WHERE farmer_id = '700657a1-d75d-4c72-99b1-0a0f2065fa29';  -- esperado ~1890
```

- [ ] **Step 5: Testes + build + PR**

Run: `bun run test && bun run typecheck:strict` (esperado verde).

> ⚠️ **Antes de abrir/mergear o PR — regenerar o audit de migrations.** Esta branch
> adicionou migrations custom (`carteira_omie_fase1`, `restore_sla_guards`) que ainda
> não estão no inventário. Rode `bun run audit:migrations` e commite os 2 arquivos
> regenerados (`docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql`)
> junto deste PR. É o passo 6 obrigatório do ritual `lovable-db-operator` (CLAUDE.md §5).

```bash
bun run audit:migrations   # regenera o inventário; commitar os 2 arquivos
git push -u origin feat/carteira-omie-scores-cobertura
gh pr create --title "feat(carteira): Sub-PR B — scores por dono + cobertura (Opção A)" --body "..."
```

---

## Notas de risco
- **Timeout do recompute:** `calculate-scores` já roda no universo todo em memória; medir o tempo com ~6908 clientes. Se passar de ~40s, mover o full-refresh pra cursor/continuação (estado de job) — ver decisão do codex no spec.
- **`signal_modifiers`:** continua das ligações DO DONO. Handoff (mudança de dono) com janela de transição = trabalho futuro (YAGNI agora).
- **Anti-drift:** o teste da Task 2 + os comentários travam a regra "score vem da carteira". Code review deve rejeitar qualquer volta a enumerar por atividade no full-refresh.
- **Métricas por-vendedor** (`useFarmerPerformance`, `IntelligenceManagerialTab`): continuam por `farmer_id` (= dono agora) — passam a refletir a carteira designada (correto). Conferir que não quebraram após a unique nova.
