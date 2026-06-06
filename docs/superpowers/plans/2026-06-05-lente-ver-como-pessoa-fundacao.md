# Lente "Ver como pessoa" — Plano A (Fundação segura) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a lente read-only por pessoa real cobrindo **menu lateral + bloqueio de rota + reordenação de cards**, com a infraestrutura de segurança (hook de display separado, bloqueio de escrita, guardrails de CI) — sem ainda migrar telas internas.

**Architecture:** Um hook `useDisplayAccess()` é a única coisa que a lente altera (campos `display*`, derivados do perfil REAL do alvo via `get_user_access_profile_for`). `useAuth()` continua sempre real (sessão/escrita/identidade). Um write-guard global trava mutações enquanto a lente está ativa. Menu, guards de rota e persona passam a ler `useDisplayAccess`. Telas internas (Fase 2) ficam para um plano subsequente, gerado pela auditoria (Task 11).

**Tech Stack:** React 18 + TS + Vite, Supabase JS v2, `@tanstack/react-query`, vitest. Spec: `docs/superpowers/specs/2026-06-05-lente-ver-como-pessoa-design.md`.

---

## File Structure

- **Create** `src/hooks/useDisplayAccess.ts` — fonte única de acesso de **exibição** (real ou do alvo).
- **Create** `src/hooks/__tests__/useDisplayAccess.test.tsx` — testes do hook.
- **Create** `src/lib/impersonation/lens-write-guard.ts` — flag global + Proxy que bloqueia mutações na lente.
- **Create** `src/lib/impersonation/__tests__/lens-write-guard.test.ts` — testes do guard.
- **Create** `src/lib/impersonation/__tests__/display-access-no-write.test.ts` — guardrail AST/regex (Fase 0).
- **Modify** `src/integrations/supabase/client.ts` — aplicar o write-guard ao client exportado.
- **Modify** `src/contexts/ImpersonationContext.tsx` — `setLensActive(true/false)` ao entrar/sair da lente.
- **Modify** `src/components/impersonation/ImpersonationBanner.tsx` — texto honesto + role/empresa do alvo.
- **Rewrite** `src/components/dashboard/PersonaSwitcherChip.tsx` — vira "Ver como: [pessoa]" (lista pessoas; aposenta troca manual de papel).
- **Modify** `src/components/AppShell.tsx` — menu lê `display*`; suprime badges na lente.
- **Modify** `src/components/RequireStaff.tsx` — lê `displayIsStaff`.
- **Modify** `src/components/RequireFinanceiroAccess.tsx` — na lente decide pelo alvo (não busca permissão do master).
- **Modify** `src/hooks/usePersona.ts` — lê `display*` (cards reordenam pelo alvo na lente).
- **Modify** `eslint.config.js` — `no-restricted-imports` de `useDisplayAccess` em `src/services/**`.
- **Modify** `docs/superpowers/specs/2026-06-05-lente-ver-como-pessoa-design.md` — anexo da Fase 1.5 (Task 11).

---

## Task 1: Hook `useDisplayAccess`

**Files:**
- Create: `src/hooks/useDisplayAccess.ts`
- Test: `src/hooks/__tests__/useDisplayAccess.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/__tests__/useDisplayAccess.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';

const authMock = vi.fn();
const impMock = vi.fn();
const profileMock = vi.fn();
const salesOnlyMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useImpersonatedAccessProfile', () => ({ useImpersonatedAccessProfile: () => profileMock() }));
vi.mock('@/hooks/useSalesOnlyRestriction', () => ({ useSalesOnlyRestriction: () => salesOnlyMock() }));

beforeEach(() => {
  authMock.mockReturnValue({ role: 'master', isStaff: true, isMaster: true, isGestorComercial: true });
  impMock.mockReturnValue({ isImpersonating: false, target: null });
  profileMock.mockReturnValue({ data: null, isLoading: false });
  salesOnlyMock.mockReturnValue(false);
});

describe('useDisplayAccess', () => {
  it('sem lente: espelha o acesso real do master', () => {
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: 'master', displayIsStaff: true, displayIsMaster: true,
      displayIsGestorComercial: true, displayIsSalesOnly: false, displayLoading: false,
    });
  });

  it('sem lente: reflete sales-only real', () => {
    salesOnlyMock.mockReturnValue(true);
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current.displayIsSalesOnly).toBe(true);
  });

  it('na lente, alvo vendedor employee: rebaixa master->employee', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'v1', nome: 'Regina', grupo: 'farmer' } });
    profileMock.mockReturnValue({ data: { appRole: 'employee', commercialRole: 'operacional', department: 'vendas', isSalesOnly: true }, isLoading: false });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: 'employee', displayIsStaff: true, displayIsMaster: false,
      displayIsGestorComercial: false, displayIsSalesOnly: true, displayDepartment: 'vendas', displayLoading: false,
    });
  });

  it('na lente, alvo gestor: displayIsGestorComercial=true', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'g1', nome: 'X', grupo: null } });
    profileMock.mockReturnValue({ data: { appRole: 'employee', commercialRole: 'gerencial', department: 'gestao', isSalesOnly: false }, isLoading: false });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current.displayIsGestorComercial).toBe(true);
    expect(result.current.displayIsMaster).toBe(false);
  });

  it('na lente, perfil ainda carregando: rebaixa tudo + displayLoading=true (não pisca menu do master)', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'v1', nome: 'Regina', grupo: 'farmer' } });
    profileMock.mockReturnValue({ data: null, isLoading: true });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: null, displayIsStaff: false, displayIsMaster: false, displayLoading: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/hooks/__tests__/useDisplayAccess.test.tsx`
Expected: FAIL ("Cannot find module '@/hooks/useDisplayAccess'").

- [ ] **Step 3: Write minimal implementation**

```ts
// src/hooks/useDisplayAccess.ts
import { useAuth, type AppRole } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';

const GESTOR_COMERCIAL_ROLES = ['gerencial', 'estrategico', 'super_admin'];

export interface DisplayAccess {
  displayRole: AppRole | null;
  displayIsStaff: boolean;
  displayIsMaster: boolean;
  displayIsGestorComercial: boolean;
  displayIsSalesOnly: boolean;
  displayDepartment: string | null;
  /** true enquanto o perfil do alvo carrega na lente; consumidores mostram loading, não o menu do master. */
  displayLoading: boolean;
}

/**
 * Fonte única de acesso de EXIBIÇÃO/NAVEGAÇÃO. NUNCA usar para decidir escrita ou
 * identidade — para isso, use useAuth() real. Sem lente, espelha o usuário real;
 * na lente, deriva do perfil REAL do alvo (get_user_access_profile_for).
 */
export function useDisplayAccess(): DisplayAccess {
  const { role, isStaff, isMaster, isGestorComercial } = useAuth();
  const { isImpersonating } = useImpersonation();
  const { data: targetProfile, isLoading } = useImpersonatedAccessProfile();
  const realIsSalesOnly = useSalesOnlyRestriction();

  if (!isImpersonating) {
    return {
      displayRole: role,
      displayIsStaff: isStaff,
      displayIsMaster: isMaster,
      displayIsGestorComercial: isGestorComercial,
      displayIsSalesOnly: realIsSalesOnly,
      displayDepartment: null,
      displayLoading: false,
    };
  }

  if (isLoading || !targetProfile) {
    return {
      displayRole: null, displayIsStaff: false, displayIsMaster: false,
      displayIsGestorComercial: false, displayIsSalesOnly: false,
      displayDepartment: null, displayLoading: true,
    };
  }

  const appRole = targetProfile.appRole;
  return {
    displayRole: appRole,
    displayIsStaff: appRole === 'employee' || appRole === 'master',
    displayIsMaster: appRole === 'master',
    displayIsGestorComercial: GESTOR_COMERCIAL_ROLES.includes(targetProfile.commercialRole ?? ''),
    displayIsSalesOnly: targetProfile.isSalesOnly,
    displayDepartment: targetProfile.department,
    displayLoading: false,
  };
}
```

> Nota: confirmar que `AppRole` é exportado de `AuthContext`. Se não for, exportar o type lá (`export type AppRole = ...`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/hooks/__tests__/useDisplayAccess.test.tsx`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDisplayAccess.ts src/hooks/__tests__/useDisplayAccess.test.tsx
git commit -m "feat(lente): useDisplayAccess — acesso de exibição (real ou alvo), separado de useAuth"
```

---

## Task 2: Módulo write-guard

**Files:**
- Create: `src/lib/impersonation/lens-write-guard.ts`
- Test: `src/lib/impersonation/__tests__/lens-write-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/impersonation/__tests__/lens-write-guard.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setLensActive, isLensActive, LensReadOnlyError, createLensGuardedClient } from '@/lib/impersonation/lens-write-guard';

// Fake mínimo no shape do supabase client que nos importa.
function makeFakeClient() {
  const calls: string[] = [];
  const queryBuilder = {
    select: () => { calls.push('select'); return Promise.resolve({ data: [], error: null }); },
    insert: () => { calls.push('insert'); return Promise.resolve({ data: null, error: null }); },
    update: () => { calls.push('update'); return Promise.resolve({ data: null, error: null }); },
    upsert: () => { calls.push('upsert'); return Promise.resolve({ data: null, error: null }); },
    delete: () => { calls.push('delete'); return Promise.resolve({ data: null, error: null }); },
  };
  const bucket = {
    upload: () => { calls.push('upload'); return Promise.resolve({ data: null, error: null }); },
    download: () => { calls.push('download'); return Promise.resolve({ data: null, error: null }); },
    remove: () => { calls.push('remove'); return Promise.resolve({ data: null, error: null }); },
  };
  const client = {
    from: () => queryBuilder,
    rpc: () => { calls.push('rpc'); return Promise.resolve({ data: null, error: null }); },
    storage: { from: () => bucket },
    calls,
  };
  return client;
}

beforeEach(() => setLensActive(false));

describe('lens-write-guard', () => {
  it('fora da lente: insert/update/upsert/delete passam', () => {
    const c = createLensGuardedClient(makeFakeClient());
    c.from('t').insert(); c.from('t').update(); c.from('t').upsert(); c.from('t').delete();
    expect(c.calls).toEqual(['insert', 'update', 'upsert', 'delete']);
  });

  it('na lente: insert/update/upsert/delete lançam LensReadOnlyError', () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    expect(() => c.from('t').insert()).toThrow(LensReadOnlyError);
    expect(() => c.from('t').update()).toThrow(LensReadOnlyError);
    expect(() => c.from('t').upsert()).toThrow(LensReadOnlyError);
    expect(() => c.from('t').delete()).toThrow(LensReadOnlyError);
    expect(c.calls).toEqual([]); // nenhuma mutação chegou ao client real
  });

  it('na lente: select e download continuam passando (leitura livre)', () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    c.from('t').select();
    c.storage.from('b').download();
    expect(c.calls).toEqual(['select', 'download']);
  });

  it('na lente: storage.upload/remove lançam', () => {
    const c = createLensGuardedClient(makeFakeClient());
    setLensActive(true);
    expect(() => c.storage.from('b').upload()).toThrow(LensReadOnlyError);
    expect(() => c.storage.from('b').remove()).toThrow(LensReadOnlyError);
  });

  it('isLensActive reflete o estado', () => {
    expect(isLensActive()).toBe(false);
    setLensActive(true);
    expect(isLensActive()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/lib/impersonation/__tests__/lens-write-guard.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/impersonation/lens-write-guard.ts
let lensActive = false;
export function setLensActive(v: boolean): void { lensActive = v; }
export function isLensActive(): boolean { return lensActive; }

export class LensReadOnlyError extends Error {
  constructor(public readonly op: string) {
    super(`Ação "${op}" indisponível na lente (somente leitura). Saia da lente para editar.`);
    this.name = 'LensReadOnlyError';
  }
}

const BLOCKED_QUERY = new Set(['insert', 'update', 'upsert', 'delete']);
const BLOCKED_STORAGE = new Set(['upload', 'remove', 'move', 'copy', 'createSignedUploadUrl', 'uploadToSignedUrl']);

function guardMethods<T extends object>(obj: T, blocked: Set<string>): T {
  return new Proxy(obj, {
    get(targetObj, prop, receiver) {
      const orig = Reflect.get(targetObj, prop, receiver);
      if (typeof prop === 'string' && blocked.has(prop) && typeof orig === 'function') {
        return (...args: unknown[]) => {
          if (lensActive) throw new LensReadOnlyError(prop);
          return (orig as (...a: unknown[]) => unknown).apply(targetObj, args);
        };
      }
      return orig;
    },
  });
}

/**
 * Envolve o supabase client para bloquear mutações PostgREST e de storage enquanto
 * a lente está ativa. NÃO é barreira de segurança (o servidor ainda autoriza o
 * master) — torna o "somente leitura" verdade no cliente. RPCs passam (a própria
 * lente usa RPCs de leitura); RPCs mutantes raras são guardadas explicitamente na
 * Fase 2 quando a auditoria as identifica.
 */
export function createLensGuardedClient<T extends {
  from: (...a: never[]) => unknown;
  storage: { from: (...a: never[]) => unknown };
}>(client: T): T {
  return new Proxy(client, {
    get(targetObj, prop, receiver) {
      if (prop === 'from') {
        return (...args: unknown[]) => guardMethods((targetObj.from as (...a: unknown[]) => object)(...args), BLOCKED_QUERY);
      }
      if (prop === 'storage') {
        const storage = Reflect.get(targetObj, prop, receiver) as { from: (...a: unknown[]) => object };
        return new Proxy(storage, {
          get(sObj, sProp, sRecv) {
            if (sProp === 'from') {
              return (...args: unknown[]) => guardMethods((sObj.from as (...a: unknown[]) => object)(...args), BLOCKED_STORAGE);
            }
            return Reflect.get(sObj, sProp, sRecv);
          },
        });
      }
      return Reflect.get(targetObj, prop, receiver);
    },
  });
}
```

> If a test fails because the real supabase query builder is chainable (`.from().update().eq()`), the guard already returns the original builder for non-blocked methods, so chaining works. The block fires at the mutation method itself. Adjust only if a test demands it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/lib/impersonation/__tests__/lens-write-guard.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/impersonation/lens-write-guard.ts src/lib/impersonation/__tests__/lens-write-guard.test.ts
git commit -m "feat(lente): write-guard que bloqueia mutações enquanto a lente está ativa"
```

---

## Task 3: Aplicar o guard ao client + ligar/desligar na lente

**Files:**
- Modify: `src/integrations/supabase/client.ts`
- Modify: `src/contexts/ImpersonationContext.tsx`

- [ ] **Step 1: Envolver o client exportado**

Em `src/integrations/supabase/client.ts`, trocar o `export const supabase = createClient(...)` por:

```ts
// This file is automatically generated. Do not edit it directly.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { createLensGuardedClient } from '@/lib/impersonation/lens-write-guard';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

// Write-guard da lente "ver como pessoa": bloqueia mutações enquanto a lente está
// ativa. Preservar este wrap se este arquivo for regenerado pelo Lovable.
export const supabase = createLensGuardedClient(
  createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: localStorage, persistSession: true, autoRefreshToken: true },
  })
);
```

- [ ] **Step 2: Setar a flag ao entrar/sair da lente**

Em `src/contexts/ImpersonationContext.tsx`, importar `setLensActive` e chamá-lo num effect que segue `!!target`:

```ts
import { setLensActive } from '@/lib/impersonation/effective-user'; // se reexportado lá
// OU diretamente:
import { setLensActive } from '@/lib/impersonation/lens-write-guard';
```

Adicionar, dentro do `ImpersonationProvider`, após a declaração de `target`:

```ts
  useEffect(() => {
    setLensActive(!!target);
    return () => setLensActive(false);
  }, [target]);
```

- [ ] **Step 3: Verificar build e suíte**

Run: `bun run typecheck && bun run test -- src/lib/impersonation`
Expected: typecheck PASS; testes do guard PASS.

- [ ] **Step 4: Commit**

```bash
git add src/integrations/supabase/client.ts src/contexts/ImpersonationContext.tsx
git commit -m "feat(lente): aplica write-guard ao client e liga/desliga com a lente"
```

---

## Task 4: Guardrails de CI (Fase 0)

**Files:**
- Create: `src/lib/impersonation/__tests__/display-access-no-write.test.ts`
- Modify: `eslint.config.js`

- [ ] **Step 1: Write the failing test (guardrail AST/regex)**

```ts
// src/lib/impersonation/__tests__/display-access-no-write.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

const MUTATION = /\.(insert|update|upsert|delete)\s*\(/;

describe('guardrail: useDisplayAccess nunca convive com mutação', () => {
  it('nenhum arquivo que importa useDisplayAccess contém .insert/.update/.upsert/.delete', () => {
    const offenders = walk('src')
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return /useDisplayAccess/.test(src) && MUTATION.test(src);
      });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes now (no offenders yet)**

Run: `bun run test -- src/lib/impersonation/__tests__/display-access-no-write.test.ts`
Expected: PASS (nenhum consumidor de `useDisplayAccess` faz mutação ainda). This guardrail FAILS the day someone mixes them — that is the point.

- [ ] **Step 3: ESLint — proibir useDisplayAccess em services**

Em `eslint.config.js`, adicionar um bloco `no-restricted-imports` escopado a `src/services/**` (seguir o padrão do bloco `no-restricted-syntax` já existente). Regra:

```js
{
  files: ['src/services/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{
        name: '@/hooks/useDisplayAccess',
        message: 'useDisplayAccess é só para exibição/navegação. Camada de serviço/escrita usa useAuth() real.',
      }],
    }],
  },
},
```

- [ ] **Step 4: Run lint**

Run: `bun lint`
Expected: PASS (nenhum service importa o hook hoje).

- [ ] **Step 5: Commit**

```bash
git add src/lib/impersonation/__tests__/display-access-no-write.test.ts eslint.config.js
git commit -m "test(lente): guardrails CI — useDisplayAccess proibido em escrita/serviços"
```

---

## Task 5: Banner honesto

**Files:**
- Modify: `src/components/impersonation/ImpersonationBanner.tsx`

- [ ] **Step 1: Reescrever o banner com texto preciso + role/empresa do alvo**

```tsx
// src/components/impersonation/ImpersonationBanner.tsx
import { Eye, X } from 'lucide-react';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';

export function ImpersonationBanner() {
  const { isImpersonating, target, stopImpersonation } = useImpersonation();
  const { user } = useAuth();
  const { data: perfil } = useImpersonatedAccessProfile();
  if (!isImpersonating || !target) return null;
  const contexto = [perfil?.commercialRole, perfil?.department].filter(Boolean).join(' · ');
  return (
    <div className="w-full bg-status-warning-bold text-white text-xs flex items-center justify-center gap-3 py-1 px-3">
      <Eye className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        Lente de navegação/leitura como <strong>{target.nome}</strong>
        {contexto ? ` (${contexto})` : ''} · escritas bloqueadas · RLS continua sendo {user?.email ?? 'master'}
      </span>
      <button onClick={() => stopImpersonation()} className="flex items-center gap-1 underline shrink-0">
        <X className="w-3.5 h-3.5" /> Sair
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/impersonation/ImpersonationBanner.tsx
git commit -m "feat(lente): banner honesto (navegação/leitura, escritas bloqueadas, RLS do master)"
```

---

## Task 6: Entrada "Ver como: [pessoa]" (aposenta troca manual de papel)

**Files:**
- Rewrite: `src/components/dashboard/PersonaSwitcherChip.tsx`

Contexto: hoje o chip lista PAPÉIS (`PERSONAS`) e chama `setOverride`. Vira um seletor de PESSOAS reais (via `useImpersonationTargets`) que aciona a lente (`startImpersonation`). A reordenação automática de cards continua viva em `usePersona`/`DashboardPersonaContext` (não removida).

- [ ] **Step 1: Reescrever o chip**

```tsx
// src/components/dashboard/PersonaSwitcherChip.tsx
import { ChevronDown, Check, Eye } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useImpersonationTargets } from '@/hooks/useImpersonationTargets';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

export function PersonaSwitcherChip() {
  const { isMaster } = useAuth();
  const { data: targets = [], isLoading } = useImpersonationTargets();
  const { isImpersonating, target, startImpersonation, stopImpersonation } = useImpersonation();

  if (!isMaster) return null; // a lente é master-only

  const label = isImpersonating && target ? target.nome : 'você';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-background/60 backdrop-blur border border-border/60 text-xs font-medium text-foreground hover:bg-background/80 transition-colors"
        >
          <Eye className="w-3 h-3 opacity-70" />
          <span className="text-muted-foreground">Ver como:</span>
          <span>{label}</span>
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="p-3 border-b border-border">
          <p className="text-xs font-semibold text-foreground">Ver o app como outra pessoa</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Menu, navegação e dados ficam como os dela. Somente leitura.
          </p>
        </div>
        <div className="py-1 max-h-72 overflow-y-auto">
          <button
            onClick={() => stopImpersonation()}
            className={cn('w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-start gap-2', !isImpersonating && 'bg-muted/60')}
          >
            <Check className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', !isImpersonating ? 'opacity-100' : 'opacity-0')} />
            <div className="text-sm font-medium text-foreground">Você (master)</div>
          </button>
          {isLoading && <div className="px-3 py-2 text-[11px] text-muted-foreground">Carregando…</div>}
          {targets.map((t) => {
            const active = isImpersonating && target?.id === t.id;
            return (
              <button
                key={t.id}
                onClick={() => startImpersonation(t, 'Lente via chip do dashboard')}
                className={cn('w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-start gap-2', active && 'bg-muted/60')}
              >
                <Check className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{t.nome}</div>
                  {t.grupo && <div className="text-[11px] text-muted-foreground">{t.grupo}</div>}
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Limpar imports órfãos**

Verificar se `PERSONAS`/`PERSONA_CONFIG`/`useDashboardPersonaContext`/`track` ainda são usados em outro lugar (a inferência automática em `usePersona`/`DashboardPersonaContext` permanece; só o chip parou de usá-los). Rodar:

Run: `bun run typecheck && bun lint`
Expected: PASS (sem unused). Se `track`/`SOURCE_LABEL` ficarem órfãos no arquivo, foram removidos junto na reescrita acima — ok.

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/PersonaSwitcherChip.tsx
git commit -m "feat(lente): chip vira 'Ver como: pessoa' (lista pessoas reais; aposenta troca manual de papel)"
```

---

## Task 7: AppShell lê `useDisplayAccess` (menu + badges)

**Files:**
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Trocar a fonte do gating do menu**

No `AppShell.tsx`, nos DOIS pontos de filtro (sidebar desktop ~linha 357/615 e MobileNav ~712/741), trocar a leitura de `useAuth()`/`useSalesOnlyRestriction()` por `useDisplayAccess()` **apenas para o gating do menu**:

Antes (desktop, ~357):
```tsx
const { isStaff, isMaster, isGestorComercial, user } = useAuth();
const isSalesOnly = useSalesOnlyRestriction();
```
Depois:
```tsx
const { user } = useAuth();
const { displayIsStaff: isStaff, displayIsMaster: isMaster, displayIsGestorComercial: isGestorComercial, displayIsSalesOnly: isSalesOnly, displayLoading } = useDisplayAccess();
```

Aplicar a mesma troca no `MobileNav` (~712). Os filtros existentes (`(!item.managerOnly || isStaff) && (!item.masterOnly || isMaster) && (!item.gestorComercialOuMaster || isMaster || isGestorComercial)` e `if (isSalesOnly && section.title !== 'Vendas') return null;`) **não mudam** — só a origem dos booleanos.

- [ ] **Step 2: Suprimir badges numéricos na lente**

Os badges de menu rodam queries com a sessão do master → mostrariam número do master no menu do alvo. Importar `useImpersonation` e, na lente, zerar/ocultar o badge. No ponto onde o item recebe `badge`, envolver:

```tsx
const { isImpersonating } = useImpersonation();
// ...ao montar os items com badge:
badge: isImpersonating ? undefined : <valorDoBadge>,
```

(Aplicar a cada `badge:` dos items que hoje recebem contagem.)

- [ ] **Step 3: Estado de carregamento da lente**

Quando `displayLoading` é true (perfil do alvo carregando), renderizar o esqueleto/skeleton da sidebar em vez do menu do master. Adicionar guard simples no topo do render da nav: se `displayLoading`, renderizar os itens como vazios/placeholder até resolver.

- [ ] **Step 4: Verificar**

Run: `bun run typecheck && bun run test`
Expected: PASS. Manual: sem lente, o menu do master é idêntico ao de hoje (regressão zero).

- [ ] **Step 5: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat(lente): menu lateral reflete o acesso do alvo; badges suprimidos na lente"
```

---

## Task 8: `RequireStaff` lê `displayIsStaff`

**Files:**
- Modify: `src/components/RequireStaff.tsx`

- [ ] **Step 1: Trocar a fonte**

```tsx
// src/components/RequireStaff.tsx
import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';

export const RequireStaff = () => {
  const { loading } = useAuth();
  const { displayIsStaff, displayLoading } = useDisplayAccess();

  if (loading || displayLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!displayIsStaff) return <Navigate to="/" replace />;
  return <Outlet />;
};
```

- [ ] **Step 2: Verificar**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/RequireStaff.tsx
git commit -m "feat(lente): RequireStaff reflete o acesso do alvo"
```

---

## Task 9: `RequireFinanceiroAccess` decide pelo alvo na lente

**Files:**
- Modify: `src/components/RequireFinanceiroAccess.tsx`

Regra: **na lente, NUNCA chamar `getMinhaPermissao()`** (é a permissão do master). Decidir só por `displayIsStaff`. Fora da lente, comportamento idêntico ao atual.

- [ ] **Step 1: Aplicar a bifurcação**

```tsx
// src/components/RequireFinanceiroAccess.tsx  (topo do componente)
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
// ...
export const RequireFinanceiroAccess = () => {
  const { isStaff, loading } = useAuth();
  const { isImpersonating } = useImpersonation();
  const { displayIsStaff, displayLoading } = useDisplayAccess();

  // Na lente: decide só pelo perfil do alvo, sem consultar a permissão do master.
  if (isImpersonating) {
    if (loading || displayLoading) {
      return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
    }
    return displayIsStaff ? <Outlet /> : <SemAcessoFinanceiro />;
  }

  // Fora da lente: comportamento original (staff OU fin_permissoes do próprio user).
  // ...resto do componente atual inalterado (a query getMinhaPermissao só roda aqui)...
};
```

Extrair o markup do "Sem acesso ao Financeiro" atual num componente local `SemAcessoFinanceiro` (mesmo JSX que já existe), reusado nos dois caminhos.

- [ ] **Step 2: Verificar**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/RequireFinanceiroAccess.tsx
git commit -m "feat(lente): guard do Financeiro decide pelo alvo na lente (não consulta permissão do master)"
```

---

## Task 10: `usePersona` lê `display*` (cards reordenam pelo alvo)

**Files:**
- Modify: `src/hooks/usePersona.ts`

- [ ] **Step 1: Alimentar a inferência com os sinais de exibição**

Trocar as fontes reais por `useDisplayAccess` para que, na lente, a persona inferida (e logo a ordem dos cards) reflita o alvo:

```tsx
// src/hooks/usePersona.ts
import { useMemo } from 'react';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { getRouteCounts } from '@/lib/dashboard/route-tracker';
import { inferPersona, type InferPersonaResult } from '@/lib/dashboard/persona-detect';
import type { Persona } from '@/lib/dashboard/persona-config';
import type { CommercialRole } from '@/hooks/useCommercialRole';
import type { Department } from '@/integrations/supabase/types-departments';

export function usePersona(override: Persona | null): InferPersonaResult {
  const { displayRole, displayIsSalesOnly, displayIsGestorComercial, displayDepartment } = useDisplayAccess();

  return useMemo(() => {
    // Deriva commercialRole a partir do display (suficiente para a inferência de persona).
    const commercialRole: CommercialRole | null = displayIsGestorComercial ? 'gerencial' : null;
    return inferPersona({
      override,
      role: displayRole,
      commercialRole,
      isSalesOnly: displayIsSalesOnly,
      routeCounts: getRouteCounts(),
      userDepartment: (displayDepartment as Department | null) ?? null,
    });
  }, [override, displayRole, displayIsSalesOnly, displayIsGestorComercial, displayDepartment]);
}
```

> Nota: `inferPersona` distingue `operacional`→vendedor de `gerencial`→gestor. Como o display só nos dá "é gestor comercial?", mapeamos gestor→`gerencial`, não-gestor→`null` (cai na heurística/department/default). Para o alvo, o `displayDepartment` já direciona a persona certa antes da heurística — suficiente para a ordem de cards. Se precisar de mais granularidade do commercialRole do alvo no futuro, expor `displayCommercialRole` em `useDisplayAccess`.

- [ ] **Step 2: Verificar**

Run: `bun run typecheck && bun run test`
Expected: PASS. Os testes de `persona-detect` não mudam (a lógica pura é a mesma).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePersona.ts
git commit -m "feat(lente): persona/ordem de cards reflete o alvo na lente"
```

---

## Task 11: Fase 1.5 — Auditoria de callsites (input da Fase 2)

**Files:**
- Modify: `docs/superpowers/specs/2026-06-05-lente-ver-como-pessoa-design.md` (preencher o anexo §13)

Não há código aqui — é o levantamento que dimensiona e desbloqueia a Fase 2.

- [ ] **Step 1: Listar todos os callsites**

Run:
```bash
grep -rn "isMaster\|isStaff\|isGestorComercial" src/pages src/components --include="*.tsx" | grep -v node_modules > /tmp/lente-callsites.txt
wc -l /tmp/lente-callsites.txt
```

- [ ] **Step 2: Classificar cada um**

Para cada callsite, marcar uma categoria:
- **display** — decide só mostrar/ocultar UI → elegível para `useDisplayAccess` na Fase 2.
- **read-enabled** — decide `enabled` de query de leitura → elegível (rebaixar esconde leitura, que é o efeito desejado na lente).
- **write-identity** — decide payload, autorização de escrita, `user.id` de gravação, ou identidade → **fica em `useAuth()` real, NÃO migrar.** (Conhecidos: `CoveragePanel.tsx`, `AdminStandardProcessDetail.tsx`.)

- [ ] **Step 3: Cruzar com "o alvo acessa a tela?"**

Marcar quais telas um alvo típico (vendedor) realmente alcança (via menu/rota após Fase 1). Telas barradas por rota saem do escopo da Fase 2.

- [ ] **Step 4: Escrever o anexo no spec**

Substituir o §13 do spec por uma tabela `arquivo:linha | categoria | tela acessível pelo alvo? | ação (migrar/manter)`. Commit:

```bash
git add docs/superpowers/specs/2026-06-05-lente-ver-como-pessoa-design.md
git commit -m "docs(lente): Fase 1.5 — auditoria e classificação dos callsites de acesso"
```

---

## Self-Review (preenchido)

**Spec coverage:** §5.1 hook → Task 1; §5.2 write-guard → Tasks 2-3; §5.3 banner → Task 5; §5.4 entrada/fusão → Task 6; Fase 0 guardrails → Task 4; Fase 1 menu/rotas/persona → Tasks 7-10; Fase 1.5 auditoria → Task 11; aposentadoria PersonaSwitcher → Task 6; furo do RequireFinanceiroAccess (§7) → Task 9; badges (§7) → Task 7. **Fase 2 (telas) NÃO está aqui** — é plano subsequente, por dependência da Task 11 (declarado no Goal/Handoff).

**Placeholder scan:** sem TBD/TODO. O §13 do spec é "a preencher" **por design** (é a entrega da Task 11).

**Type consistency:** `DisplayAccess` (campos `displayIsStaff/displayIsMaster/displayIsGestorComercial/displayIsSalesOnly/displayRole/displayDepartment/displayLoading`) usada igual nas Tasks 1, 7, 8, 9, 10. `setLensActive/isLensActive/LensReadOnlyError/createLensGuardedClient` consistentes entre Tasks 2 e 3.

**Riscos de execução conhecidos:** (a) o Proxy do client supabase pode precisar de ajuste fino se o builder real encadear de forma inesperada — os testes da Task 2 são o contrato que guia o ajuste; (b) confirmar que `get_user_access_profile_for` devolve `department` (o `useImpersonatedAccessProfile` já mapeia, mas validar valor real na Task 1/execução).

---

## Execution Handoff

Após a Fase 1.5 (Task 11), a **Fase 2** (migrar telas internas elegíveis) vira um **plano subsequente** gerado a partir do anexo da auditoria — uma task de migração por tela/callsite, com TDD onde houver lógica.
