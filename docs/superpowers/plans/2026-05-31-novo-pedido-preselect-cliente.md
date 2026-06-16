# Pré-seleção de cliente no "Novo pedido" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/sales/new?customer=<user_id>` pré-seleciona o cliente no fluxo de pedido staff, reusando o `selectCustomer` existente.

**Architecture:** Helper puro `buildOmieCustomer` (TDD) → método `selectCustomerByUserId` no `useUnifiedOrder` (2 lookups paralelos + build + `selectCustomer`) → `useEffect` run-once no `UnifiedOrder.tsx` que lê o param. Degradação silenciosa; money-path (`selectCustomer`) intacto.

**Tech Stack:** React + react-router-dom (`useSearchParams`), Supabase JS, vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-novo-pedido-preselect-cliente-design.md`

---

## File Structure

- **Create:** `src/lib/unified-order/build-omie-customer.ts` — helper puro que monta `OmieCustomer | null` dos 2 registros.
- **Create:** `src/lib/unified-order/__tests__/build-omie-customer.test.ts` — testes do helper.
- **Modify:** `src/hooks/useUnifiedOrder.ts` — adiciona `selectCustomerByUserId` (data layer) + expõe no return.
- **Modify:** `src/pages/UnifiedOrder.tsx` — lê `?customer=` e dispara a pré-seleção uma vez.

---

## Task 1: Helper puro `buildOmieCustomer` (TDD)

**Files:**
- Create: `src/lib/unified-order/build-omie-customer.ts`
- Test: `src/lib/unified-order/__tests__/build-omie-customer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/unified-order/__tests__/build-omie-customer.test.ts
import { describe, it, expect } from 'vitest';
import { buildOmieCustomer } from '../build-omie-customer';

const UID = 'user-123';

describe('buildOmieCustomer', () => {
  it('monta OmieCustomer completo com profile + mapeamento omie', () => {
    const r = buildOmieCustomer(
      UID,
      { razao_social: 'ACME LTDA', name: 'Acme', document: '12345678000199' },
      { omie_codigo_cliente: 555, omie_codigo_vendedor: 42 },
    );
    expect(r).toEqual({
      codigo_cliente: 555,
      razao_social: 'ACME LTDA',
      nome_fantasia: 'Acme',
      cnpj_cpf: '12345678000199',
      codigo_vendedor: 42,
      local_user_id: UID,
    });
  });

  it('sem mapeamento omie → codigo_cliente=0 e vendedor null (cliente local)', () => {
    const r = buildOmieCustomer(
      UID,
      { razao_social: 'ACME LTDA', name: 'Acme', document: '123' },
      null,
    );
    expect(r?.codigo_cliente).toBe(0);
    expect(r?.codigo_vendedor).toBeNull();
    expect(r?.local_user_id).toBe(UID);
  });

  it('sem profile → null (não dá pra identificar)', () => {
    expect(buildOmieCustomer(UID, null, { omie_codigo_cliente: 555, omie_codigo_vendedor: 42 })).toBeNull();
  });

  it('razao_social ausente → cai pro name', () => {
    const r = buildOmieCustomer(UID, { razao_social: null, name: 'Acme', document: '123' }, null);
    expect(r?.razao_social).toBe('Acme');
  });

  it('document ausente → cnpj_cpf string vazia (tipo exige string)', () => {
    const r = buildOmieCustomer(UID, { razao_social: 'ACME', name: 'Acme', document: null }, null);
    expect(r?.cnpj_cpf).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/novo-pedido-preselect && heavy bun run test -- build-omie-customer`
Expected: FAIL — `Cannot find module '../build-omie-customer'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/unified-order/build-omie-customer.ts
import type { OmieCustomer } from '@/hooks/unifiedOrder/types';

export interface ProfileIdentity {
  razao_social: string | null;
  name: string | null;
  document: string | null;
}

export interface OmieMapping {
  omie_codigo_cliente: number;
  omie_codigo_vendedor: number | null;
}

/**
 * Monta um OmieCustomer a partir da identidade (profiles) + mapeamento (omie_clientes),
 * ambos buscados por user_id. Puro (sem I/O). Retorna null se não há identidade mínima
 * (sem profile não dá pra pré-selecionar). codigo_cliente=0 = cliente local/não-sincronizado,
 * caso que o fluxo manual de pedido já trata.
 */
export function buildOmieCustomer(
  userId: string,
  profile: ProfileIdentity | null,
  omie: OmieMapping | null,
): OmieCustomer | null {
  if (!profile) return null;
  const nome = profile.razao_social || profile.name || '';
  return {
    codigo_cliente: omie?.omie_codigo_cliente ?? 0,
    razao_social: nome,
    nome_fantasia: profile.name || nome,
    cnpj_cpf: profile.document ?? '',
    codigo_vendedor: omie?.omie_codigo_vendedor ?? null,
    local_user_id: userId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/novo-pedido-preselect && heavy bun run test -- build-omie-customer`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/unified-order/build-omie-customer.ts src/lib/unified-order/__tests__/build-omie-customer.test.ts
git commit -m "feat(novo-pedido): helper puro buildOmieCustomer (user_id → OmieCustomer)"
```

---

## Task 2: `selectCustomerByUserId` no `useUnifiedOrder`

**Files:**
- Modify: `src/hooks/useUnifiedOrder.ts`

Contexto: o hook já importa `supabase` e `useCallback`, já tem `selectCustomer` (de `useCustomerSelection`) e o precedente `handleAICustomerSelect` (resolve por user_id e chama `selectCustomer`). Adicionar um método irmão focado, que parte só do `user_id`.

- [ ] **Step 1: Adicionar o import do helper**

No topo de `src/hooks/useUnifiedOrder.ts`, junto aos demais imports de `@/lib` / `@/hooks`:

```ts
import { buildOmieCustomer } from '@/lib/unified-order/build-omie-customer';
```

- [ ] **Step 2: Definir `selectCustomerByUserId`**

Logo **após** a definição de `handleAICustomerSelect` (o `useCallback` que termina em `}, [selectCustomer]);`), adicionar:

```ts
  // Pré-seleção por user_id (deep-link "Novo pedido" do Customer 360).
  // Busca identidade (profiles) + mapeamento Omie (omie_clientes) por user_id,
  // monta o OmieCustomer e reusa o selectCustomer existente. Falha → silencioso
  // (não pré-seleciona; o vendedor escolhe no passo Cliente). NÃO altera o money-path.
  const selectCustomerByUserId = useCallback(async (userId: string) => {
    if (!userId) return;
    try {
      const [{ data: profile }, { data: omie }] = await Promise.all([
        supabase.from('profiles')
          .select('razao_social, name, document')
          .eq('user_id', userId).maybeSingle(),
        supabase.from('omie_clientes')
          .select('omie_codigo_cliente, omie_codigo_vendedor')
          .eq('user_id', userId).maybeSingle(),
      ]);
      const omieCustomer = buildOmieCustomer(userId, profile, omie);
      if (omieCustomer) await selectCustomer(omieCustomer);
    } catch {
      // fallback silencioso: mantém o fluxo manual intacto
    }
  }, [selectCustomer]);
```

- [ ] **Step 3: Expor no return do hook**

No objeto retornado (bloco `return { ... }`, seção `// Customer`), adicionar `selectCustomerByUserId` ao lado de `selectCustomer`:

```ts
    loadingCustomer, customerUserId, selectCustomer, selectCustomerByUserId, clearCustomer,
```

(Substitui a linha existente `loadingCustomer, customerUserId, selectCustomer, clearCustomer,` — apenas inserindo `selectCustomerByUserId,` após `selectCustomer,`.)

- [ ] **Step 4: Verificar typecheck**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/novo-pedido-preselect && heavy bun run typecheck`
Expected: exit 0 (sem erros). Confirma que o select tipa contra `profiles`/`omie_clientes` e que `profile`/`omie` batem com `ProfileIdentity`/`OmieMapping` do helper.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useUnifiedOrder.ts
git commit -m "feat(novo-pedido): selectCustomerByUserId no useUnifiedOrder (reusa selectCustomer)"
```

---

## Task 3: Fiação no `UnifiedOrder.tsx` (ler `?customer=` + run-once)

**Files:**
- Modify: `src/pages/UnifiedOrder.tsx`

- [ ] **Step 1: Adicionar imports `useRef` e `useSearchParams`**

Linha 1 — adicionar `useRef`:
```ts
import { useEffect, useMemo, useRef, useState } from 'react';
```
Adicionar (após os imports de react-router já existentes, ou junto aos imports do topo):
```ts
import { useSearchParams } from 'react-router-dom';
```

- [ ] **Step 2: Ler o param e disparar a pré-seleção uma vez**

Logo após `const h = useUnifiedOrder();` (linha ~46), adicionar:

```ts
  const [searchParams] = useSearchParams();
  const preselectCustomerId = searchParams.get('customer');
  const preselectedRef = useRef(false);

  useEffect(() => {
    if (
      preselectCustomerId &&
      h.isStaff &&
      !h.selectedCustomer &&
      !preselectedRef.current
    ) {
      preselectedRef.current = true;
      void h.selectCustomerByUserId(preselectCustomerId);
    }
  }, [preselectCustomerId, h.isStaff, h.selectedCustomer, h.selectCustomerByUserId]);
```

> O stepper avança sozinho: `currentStep` deriva de `selectedCustomer`. O `loadingCustomer` existente cobre o tempo da resolução. O guard `!h.selectedCustomer` evita sobrescrever seleção manual; o `preselectedRef` garante run-once mesmo se o efeito re-rodar.

- [ ] **Step 3: Verificar typecheck + lint**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/novo-pedido-preselect && heavy bun run typecheck && heavy bun run lint`
Expected: typecheck exit 0; lint 0 errors (warnings de exhaustive-deps pré-existentes OK). Se o lint apontar `exhaustive-deps` na nova `useEffect`, as deps já estão completas (`preselectCustomerId, h.isStaff, h.selectedCustomer, h.selectCustomerByUserId`) — não suprimir.

- [ ] **Step 4: Commit**

```bash
git add src/pages/UnifiedOrder.tsx
git commit -m "feat(novo-pedido): UnifiedOrder lê ?customer= e pré-seleciona (run-once, staff)"
```

---

## Task 4: Validação final

**Files:** nenhum (só validação)

- [ ] **Step 1: Suíte completa**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/novo-pedido-preselect && heavy bun run typecheck && heavy bun run lint && heavy bun run test && heavy bun run build`
Expected: typecheck 0 · lint 0 errors · test todos passando (incl. os 5 novos do buildOmieCustomer) · build ✓.

- [ ] **Step 2: Confirmar escopo intacto**

Run: `git diff --stat origin/main`
Expected: só 4 arquivos tocados (2 criados em `src/lib/unified-order/`, `useUnifiedOrder.ts`, `UnifiedOrder.tsx`). `CustomerHero.tsx`, `selectCustomer`/`useCustomerSelection` **não** aparecem (money-path intacto).

---

## Self-Review (autor do plano)

**Spec coverage:**
- §3.1 helper puro → Task 1 ✓
- §3.2 selectCustomerByUserId (2 lookups paralelos + buildOmieCustomer + selectCustomer + fallback silencioso) → Task 2 ✓
- §3.3 fiação UnifiedOrder (param + run-once + staff + sem-seleção-prévia) → Task 3 ✓
- §4 privacidade (só user_id na URL) → CustomerHero já manda só `user_id` (#516), inalterado ✓
- §5 degradação (reusa selectCustomer; run-once; fallback silencioso) → Tasks 2/3 ✓
- §6 testes (buildOmieCustomer TDD; fiação → QA manual) → Task 1 + nota no Task 4 ✓
- §7 fora de escopo (não toca selectCustomer/handleAICustomerSelect/CustomerHero) → confirmado no Task 4 Step 2 ✓

**Placeholder scan:** nenhum TBD/TODO; todo passo tem código real.

**Type consistency:** `buildOmieCustomer(userId, profile, omie)` — assinatura idêntica em Task 1 (def) e Task 2 (uso). `ProfileIdentity` = `{razao_social, name, document}` bate com o `.select('razao_social, name, document')`. `OmieMapping` = `{omie_codigo_cliente, omie_codigo_vendedor}` bate com o `.select('omie_codigo_cliente, omie_codigo_vendedor')`. `selectCustomerByUserId` exposto no return (Task 2 Step 3) e consumido como `h.selectCustomerByUserId` (Task 3 Step 2). `OmieCustomer` importado de `@/hooks/unifiedOrder/types`.
