# Picking Auto-detect Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separador touch que abre `/admin/estoque/picking` é auto-roteado pra `TouchPickingView` (visão de chão), com escape hatch bidirecional; gestor desktop fica nas 4 abas.

**Architecture:** Hook puro de decisão (`shouldRedirectToMobile`) + preferência sticky em localStorage. `AdminEstoquePicking` redireciona via `useEffect` quando `useIsTouchDevice()` confirma touch e não há override. Links de escape nos dois sentidos. Sem migration, sem tocar dados/mutação.

**Tech Stack:** React 18 + react-router-dom (useNavigate) + `useIsTouchDevice` (existente) + localStorage + vitest.

**Spec base:** [docs/superpowers/specs/2026-05-25-picking-auto-mobile-design.md](../specs/2026-05-25-picking-auto-mobile-design.md)

**Baseline:** vitest 937 passed (main, 2026-05-25). Não regredir.

---

## File Structure

**Novos:**
```
src/lib/picking/view-pref.ts                  # decisão pura + preferência localStorage
src/lib/picking/__tests__/view-pref.test.ts   # 6 cenários
```

**Editados:**
```
src/pages/AdminEstoquePicking.tsx       # redirect effect + link "Versão de chão"
src/pages/picking/TouchPickingView.tsx  # link "Ver versão completa"
```

---

### Task 1: `view-pref.ts` (TDD)

**Files:**
- Create: `src/lib/picking/view-pref.ts`
- Test: `src/lib/picking/__tests__/view-pref.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/lib/picking/__tests__/view-pref.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldRedirectToMobile, getForceFullPref, setForceFull } from '../view-pref';

beforeEach(() => localStorage.clear());

describe('shouldRedirectToMobile', () => {
  it('touch sem override → redireciona', () => {
    expect(shouldRedirectToMobile({ isTouch: true, forceFull: false })).toBe(true);
  });
  it('touch com override → NÃO redireciona', () => {
    expect(shouldRedirectToMobile({ isTouch: true, forceFull: true })).toBe(false);
  });
  it('não-touch → NÃO redireciona', () => {
    expect(shouldRedirectToMobile({ isTouch: false, forceFull: false })).toBe(false);
  });
});

describe('getForceFullPref / setForceFull', () => {
  it('default é false', () => {
    expect(getForceFullPref()).toBe(false);
  });
  it('setForceFull(true) persiste', () => {
    setForceFull(true);
    expect(getForceFullPref()).toBe(true);
  });
  it('setForceFull(false) limpa', () => {
    setForceFull(true);
    setForceFull(false);
    expect(getForceFullPref()).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

Run: `bun run vitest run src/lib/picking/__tests__/view-pref.test.ts`
Expected: FAIL — `Cannot find module '../view-pref'`.

- [ ] **Step 3: Implementar**

Create `src/lib/picking/view-pref.ts`:

```ts
const KEY = 'picking_view';

/** True quando o usuário forçou a versão completa (desktop) num dispositivo touch. */
export function getForceFullPref(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'full';
  } catch {
    return false;
  }
}

export function setForceFull(force: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (force) localStorage.setItem(KEY, 'full');
    else localStorage.removeItem(KEY);
  } catch {
    // quota/privacy — ignora
  }
}

/** Decisão pura: separador touch sem preferência forçada → vai pra visão de chão. */
export function shouldRedirectToMobile(opts: { isTouch: boolean; forceFull: boolean }): boolean {
  return opts.isTouch && !opts.forceFull;
}
```

- [ ] **Step 4: Rodar → PASS**

Run: `bun run vitest run src/lib/picking/__tests__/view-pref.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/picking/view-pref.ts src/lib/picking/__tests__/view-pref.test.ts
git commit -m "feat(picking): view-pref (decisão de auto-redirect mobile + preferência sticky, 6 tests)"
```

---

### Task 2: `AdminEstoquePicking` — redirect + link "Versão de chão"

**Files:**
- Modify: `src/pages/AdminEstoquePicking.tsx`

- [ ] **Step 1: Imports**

Trocar a linha 1:
```ts
import { useState, useMemo, Fragment } from "react";
```
por:
```ts
import { useState, useMemo, Fragment, useEffect } from "react";
```

Trocar a linha 2:
```ts
import { useSearchParams } from "react-router-dom";
```
por:
```ts
import { useSearchParams, useNavigate } from "react-router-dom";
```

Adicionar com os outros imports (ex. após a linha que importa `ScanBar`):
```ts
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";
import { shouldRedirectToMobile, getForceFullPref, setForceFull } from "@/lib/picking/view-pref";
import { Smartphone } from "lucide-react";
```

- [ ] **Step 2: Redirect effect no componente exportado**

No corpo de `export default function AdminEstoquePicking()`, logo após `const [params, setParams] = useSearchParams();` (e antes de `const tab = ...`):

```ts
  const navigate = useNavigate();
  const isTouch = useIsTouchDevice();

  // Separador touch cai direto na visão de chão (salvo override "ver versão completa").
  useEffect(() => {
    if (shouldRedirectToMobile({ isTouch, forceFull: getForceFullPref() })) {
      navigate('/admin/estoque/picking/mobile', { replace: true });
    }
  }, [isTouch, navigate]);
```

- [ ] **Step 3: Link "Versão de chão" no header**

No `<header>`, dentro do `<div className="flex items-center gap-2">` que tem o `<Building2 />` + Select de account, adicionar ANTES do `<Building2 .../>`:

```tsx
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => { setForceFull(false); navigate('/admin/estoque/picking/mobile'); }}
          >
            <Smartphone className="h-4 w-4" />
            <span className="hidden sm:inline">Versão de chão</span>
          </Button>
```

(`Button` já está importado no arquivo.)

- [ ] **Step 4: Lint + tests**

Run:
```bash
bunx eslint src/pages/AdminEstoquePicking.tsx
bun run vitest run src/lib/picking/__tests__/view-pref.test.ts
```
Expected: zero erros de lint; 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/pages/AdminEstoquePicking.tsx
git commit -m "feat(picking): auto-redirect separador touch p/ visão de chão + link de escape"
```

---

### Task 3: `TouchPickingView` — link "Ver versão completa"

**Files:**
- Modify: `src/pages/picking/TouchPickingView.tsx`

- [ ] **Step 1: Imports**

Adicionar `useNavigate` ao import do react-router (que hoje só tem `useQuery` do react-query; o arquivo NÃO importa react-router ainda — adicionar a linha):
```ts
import { useNavigate } from 'react-router-dom';
```
Adicionar:
```ts
import { setForceFull } from '@/lib/picking/view-pref';
import { Monitor } from 'lucide-react';
```

- [ ] **Step 2: Link no topo da lista principal**

No componente `TouchPickingView` (a view de lista, NÃO o `ActiveTaskView`), instanciar o navigate no topo:
```ts
  const navigate = useNavigate();
```

No `return` da lista (o bloco que começa com `<div className="space-y-3">` contendo o `<ScanBar onScan={handleScan} placeholder="Bipe um endereço ou código pra começar" />`), adicionar logo após o `<ScanBar ... />`:

```tsx
      <div className="flex justify-end px-1">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-muted-foreground"
          onClick={() => { setForceFull(true); navigate('/admin/estoque/picking'); }}
        >
          <Monitor className="h-3.5 w-3.5" />
          Ver versão completa
        </Button>
      </div>
```

(`Button` já está importado no `TouchPickingView`.)

- [ ] **Step 3: Lint + build**

Run:
```bash
bunx eslint src/pages/picking/TouchPickingView.tsx
bun run build
```
Expected: zero erros de lint; build exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/pages/picking/TouchPickingView.tsx
git commit -m "feat(picking): link 'ver versão completa' na visão de chão (escape hatch)"
```

---

### Task 4: Validação + QA

**Files:** nenhum

- [ ] **Step 1: Suíte + lint completos**

Run:
```bash
bun run test
bun lint
```
Expected: vitest 937 + 6 novos verdes; lint sem erros novos nos arquivos tocados.

- [ ] **Step 2: QA manual**

`bun dev` →
1. DevTools → Toggle device toolbar (emular celular touch) → abrir `/admin/estoque/picking` → deve cair em `/admin/estoque/picking/mobile` (TouchPickingView).
2. Tocar "Ver versão completa" → vai pra `/admin/estoque/picking` e **fica** (4 abas), mesmo em touch.
3. Tocar "Versão de chão" no header desktop → volta pra mobile; recarregar `/picking` em touch volta a auto-redirecionar.
4. Desktop normal (mouse, sem emulação touch) → abrir `/picking` → fica nas 4 abas (sem redirect).

- [ ] **Step 3: Push + PR (com ok do founder)**

```bash
git push -u origin claude/picking-auto-mobile
```
PR title: `feat(picking): auto-detect mobile (roteamento touch + escape hatch)`

---

## Critérios de "feito"

- [ ] `shouldRedirectToMobile` + `getForceFullPref`/`setForceFull` testados (6 cenários).
- [ ] `AdminEstoquePicking` redireciona touch sem override; link "Versão de chão".
- [ ] `TouchPickingView` tem link "Ver versão completa" que seta override.
- [ ] Sem loop de redirect (override sticky + `replace: true`); sem migration.
- [ ] vitest 937 + 6 verdes; lint sem erros novos; build exit 0.
- [ ] QA manual: touch redireciona, escape hatch nos dois sentidos, desktop intacto.

## Out-of-scope

- Preferência por usuário no banco (hoje localStorage por device — correto).
- Detecção por departamento/persona (futuro RBAC).
