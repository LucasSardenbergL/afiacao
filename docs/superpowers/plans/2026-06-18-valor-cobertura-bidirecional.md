# Cobertura bidirecional no Cockpit de Valor — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor dois sinais de cobertura no `fin-valor-cockpit` (`ar_por_app` mantido = `cobertura_receita`; `app_por_ar` novo) e rebaixar a confiança só quando `app_por_ar < 0,5`.

**Architecture:** Helper TS puro `coberturaBidirecional` (testado por vitest, espelhado verbatim no edge Deno). `scoreConfiancaCockpit` ganha um campo opcional. Edge passa a calcular o par; UI mostra ambos. Retrocompat: `cobertura_receita` permanece.

**Tech Stack:** TS strict, vitest, edge Deno (Supabase), React.

Spec: `docs/superpowers/specs/2026-06-18-valor-cobertura-bidirecional-design.md`.

Comando de teste (prefixar `heavy` — semáforo de RAM): `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`

---

### Task 1: Helper `coberturaBidirecional` (src) — TDD

**Files:**
- Modify: `src/lib/financeiro/valor-cockpit-helpers.ts` (adicionar após `tituloFaturavelAR`, ~linha 57)
- Test: `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts` (novo `describe` + import)

- [ ] **Step 1: Teste falhando** — adicionar ao import `coberturaBidirecional` e o `describe`:

```ts
describe('coberturaBidirecional (dois sinais)', () => {
  it('receita > AR: ar_por_app satura em 1, app_por_ar < 1', () => {
    expect(coberturaBidirecional({ receita: 5_059_623, arFaturavel: 4_054_820 })).toEqual({
      ar_por_app: 1,
      app_por_ar: Math.min(1, 4_054_820 / 5_059_623),
    });
  });
  it('AR > receita: inverso', () => {
    const r = coberturaBidirecional({ receita: 4, arFaturavel: 5 });
    expect(r.ar_por_app).toBeCloseTo(0.8, 6);
    expect(r.app_por_ar).toBe(1);
  });
  it('iguais → ambos 1', () => {
    expect(coberturaBidirecional({ receita: 5, arFaturavel: 5 })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
  });
  it('divisor 0 não penaliza (arFaturavel=0 → ar_por_app=1; receita=0 → app_por_ar=1)', () => {
    expect(coberturaBidirecional({ receita: 5, arFaturavel: 0 }).ar_por_app).toBe(1);
    expect(coberturaBidirecional({ receita: 0, arFaturavel: 5 }).app_por_ar).toBe(1);
  });
  it('entrada não-finita → {1,1} (não fabrica penalidade)', () => {
    expect(coberturaBidirecional({ receita: NaN, arFaturavel: 5 })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
    expect(coberturaBidirecional({ receita: 5, arFaturavel: Infinity })).toEqual({ ar_por_app: 1, app_por_ar: 1 });
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR** (`coberturaBidirecional is not exported`)

Run: `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`
Expected: FAIL (não exportado)

- [ ] **Step 3: Implementar** — adicionar em `valor-cockpit-helpers.ts` após `tituloFaturavelAR`:

```ts
// Dois sinais de cobertura (proxy DIRECIONAL, não reconciliação). ar_por_app = quanto do AR é
// explicado por venda no app (= cobertura_receita histórica); app_por_ar = quanto da venda no app
// tem AR faturável (detecta venda sem AR — ex.: à vista/divergência). Divisor 0 ou entrada não-finita
// → 1 (indisponível NÃO fabrica penalidade — money-path).
export function coberturaBidirecional(input: { receita: number; arFaturavel: number }): { ar_por_app: number; app_por_ar: number } {
  const r = input.receita, a = input.arFaturavel;
  if (!Number.isFinite(r) || !Number.isFinite(a)) return { ar_por_app: 1, app_por_ar: 1 };
  return {
    ar_por_app: a > 0 ? Math.min(1, r / a) : 1,
    app_por_ar: r > 0 ? Math.min(1, a / r) : 1,
  };
}
```

- [ ] **Step 4: Rodar — deve PASSAR**

Run: `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: FALSIFICAÇÃO** — trocar `app_por_ar: r > 0 ? Math.min(1, a / r) : 1` por `app_por_ar: 1` (constante), rodar → o caso "AR>receita" e "receita>AR" devem ficar VERMELHOS. Reverter a sabotagem; rodar → verde.

- [ ] **Step 6: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(valor-cockpit): helper coberturaBidirecional (dois sinais) + testes"
```

---

### Task 2: `scoreConfiancaCockpit` rebaixa se `app_por_ar < 0,5` — TDD

**Files:**
- Modify: `src/lib/financeiro/valor-cockpit-helpers.ts` (input de `scoreConfiancaCockpit`, ~linha 269 + corpo)
- Test: `src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts` (`describe('scoreConfiancaCockpit'...)` existente)

- [ ] **Step 1: Teste falhando** — adicionar dois `it` ao describe existente de `scoreConfiancaCockpit` (base saudável: cobertura_receita 1, custo/ar/estoque 0, imposto false, hurdle ok):

```ts
it('app_por_ar < 0,5 → rebaixa para média com motivo de divergência', () => {
  const r = scoreConfiancaCockpit({ cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, cobertura_app_por_ar: 0.4 });
  expect(r.nivel).toBe('media');
  expect(r.motivos.some((m) => m.toLowerCase().includes('sem ar faturável'))).toBe(true);
});
it('app_por_ar 0,80 (Oben hoje) → NÃO penaliza', () => {
  const r = scoreConfiancaCockpit({ cobertura_receita: 1, custo_ausente_pct: 0, ar_indisponivel_pct: 0, estoque_ausente_pct: 0, imposto_estimado: false, cobertura_app_por_ar: 0.8 });
  expect(r.nivel).toBe('alta');
});
```

- [ ] **Step 2: Rodar — deve FALHAR** (campo não existe no tipo / regra ausente → `media` não acontece)

Run: `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar** — (a) adicionar ao input de `scoreConfiancaCockpit` (após `hurdle_indisponivel?`):

```ts
  cobertura_app_por_ar?: number; // [0,1] venda app com AR faturável; <0,5 → divergência → rebaixa
```

(b) no corpo, logo APÓS o bloco `if (input.cobertura_receita < 0.6) … else if (… < 0.85) …`, inserir:

```ts
  if (input.cobertura_app_por_ar != null && input.cobertura_app_por_ar < 0.5) rebaixar(2, `${((1 - input.cobertura_app_por_ar) * 100).toFixed(0)}% da venda do app sem AR faturável — encargo de cliente subestimado; possível divergência app↔financeiro.`);
```

- [ ] **Step 4: Rodar — deve PASSAR**

Run: `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`
Expected: PASS (todos, incl. os existentes — campo é opcional, retrocompat)

- [ ] **Step 5: FALSIFICAÇÃO** — trocar `< 0.5` por `< 0` (nunca dispara), rodar → o teste "app_por_ar < 0,5" fica VERMELHO. Reverter; verde.

- [ ] **Step 6: Commit**

```bash
git add src/lib/financeiro/valor-cockpit-helpers.ts src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts
git commit -m "feat(valor-cockpit): scoreConfiancaCockpit rebaixa se app_por_ar < 0,5"
```

---

### Task 3: Edge — espelhar helper + usar no `serve()` + payload

**Files:**
- Modify: `supabase/functions/fin-valor-cockpit/index.ts`

- [ ] **Step 1: Espelhar `coberturaBidirecional`** — adicionar após `tituloFaturavelAR` (~linha 87), VERBATIM (sem `export`):

```ts
function coberturaBidirecional(input: { receita: number; arFaturavel: number }): { ar_por_app: number; app_por_ar: number } {
  const r = input.receita, a = input.arFaturavel;
  if (!Number.isFinite(r) || !Number.isFinite(a)) return { ar_por_app: 1, app_por_ar: 1 };
  return {
    ar_por_app: a > 0 ? Math.min(1, r / a) : 1,
    app_por_ar: r > 0 ? Math.min(1, a / r) : 1,
  };
}
```

- [ ] **Step 2: Espelhar a regra no `scoreConfiancaCockpit` do edge** — adicionar `cobertura_app_por_ar?: number;` ao input e, após o bloco da `cobertura_receita`, a mesma linha `if (input.cobertura_app_por_ar != null && input.cobertura_app_por_ar < 0.5) rebaixar(2, ...)` (idêntica à do src).

- [ ] **Step 3: Usar no `serve()`** — substituir a linha do `cobertura_receita` (hoje após o `arTotal`):

```ts
    const { ar_por_app, app_por_ar } = coberturaBidirecional({ receita: res.empresa.receita, arFaturavel: arTotal });
    const cobertura_receita = ar_por_app;
```
e na chamada de `scoreConfiancaCockpit`, acrescentar `cobertura_app_por_ar: app_por_ar,` ao objeto; no `jsonResponse(...)`, acrescentar `cobertura_app_por_ar: app_por_ar,` (após `cobertura_receita`).

- [ ] **Step 4: Conferir sintaxe do edge** — `deno check supabase/functions/fin-valor-cockpit/index.ts` se o `deno` existir; senão, conferência visual de que o helper do edge é byte-idêntico ao do src (lógica).

Run: `command -v deno >/dev/null && deno check supabase/functions/fin-valor-cockpit/index.ts || echo "deno ausente — conferir espelho manualmente"`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/fin-valor-cockpit/index.ts
git commit -m "feat(valor-cockpit): edge expõe cobertura_app_por_ar (espelho verbatim)"
```

---

### Task 4: UI + tipo no service

**Files:**
- Modify: `src/services/financeiroService.ts` (~linha 1022, tipo do retorno do cockpit)
- Modify: `src/pages/FinanceiroValorCockpit.tsx` (~linha 172)

- [ ] **Step 1: Tipo** — em `financeiroService.ts`, após `cobertura_receita: number;` (linha ~1022) adicionar (opcional, robusto à ordem de deploy):

```ts
  cobertura_app_por_ar?: number;
```

- [ ] **Step 2: UI** — em `FinanceiroValorCockpit.tsx`, trocar o `<summary>` (linha ~172):

```tsx
                Confiança ({(data.cobertura_receita * 100).toFixed(0)}% do AR explicado{data.cobertura_app_por_ar != null ? ` · ${(data.cobertura_app_por_ar * 100).toFixed(0)}% das vendas com AR` : ''})
```

- [ ] **Step 3: Typecheck**

Run: `heavy bun run typecheck`
Expected: EXIT 0

- [ ] **Step 4: Commit**

```bash
git add src/services/financeiroService.ts src/pages/FinanceiroValorCockpit.tsx
git commit -m "feat(valor-cockpit): UI mostra par de cobertura + tipo no service"
```

---

### Task 5: Verificação final + Codex + handoff de deploy

- [ ] **Step 1: Suíte + typecheck completos**

Run: `heavy bun run test src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts` (verde) e `heavy bun run typecheck` (EXIT 0)

- [ ] **Step 2: `/codex challenge`** no diff do branch (adversarial money-path).

- [ ] **Step 3: PR** — corpo deve registrar ⚠️ **DOIS canais de deploy**: **Publish do frontend** (a UI muda) **+ deploy MANUAL da edge** (chat do Lovable, verbatim). Migration: nenhuma.

- [ ] **Step 4:** após merge + deploy, atualizar `docs/historico/bugs-resolvidos.md`.

## Notas
- `cobertura_app_por_ar` opcional em todo lugar (input do score, tipo do service) → retrocompat e robusto se frontend deployar antes do edge.
- Sem migration. Sem mudança no numerador/denominador (já fixados por #935/#939).
