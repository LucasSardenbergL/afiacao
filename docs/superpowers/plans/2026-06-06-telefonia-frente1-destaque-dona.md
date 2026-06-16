# Frente 1 (parte 1) — Destaque da dona no modal de chamada entrante — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Quando uma chamada entra, o `IncomingCallModal` destaca pra cada vendedora **se o cliente é da carteira DELA** ("⭐ Seu cliente — atenda") vs **de outra** ("Cliente da Regina") vs **sem dono**. É o "owner-first degradado" do spec (D5): todas tocam juntas (ring-all no Nvoip), e o destaque no app direciona socialmente.

**Architecture:** 100% frontend. Reusa o `IncomingCallModal` (que já resolve o cliente por telefone) + a RPC `wa_owner_efetivo(customer)` (já existe, considera cobertura de férias). A decisão "meu/outro/sem-dono/desconhecido" é um **helper puro testável** (`classificarRealceDono`); o resto é integração no modal. **Independente do spike (`*2`/REFER) e da config de fila no Nvoip** — funciona em qualquer chamada que chega no ramal.

**Tech Stack:** React, Supabase RPC (`wa_owner_efetivo`), `useAuth` (user logado), vitest.

**Spec:** `docs/superpowers/specs/2026-06-06-telefonia-roteamento-transferencia-design.md` (§4.2).

**Não-objetivos (v1 desta parte):** perdida + WhatsApp automático (depende de um evento de fim-de-chamada do Nvoip — fase própria); config da fila ring-all (founder, painel Nvoip); presença honesta (vem com a Frente 2).

---

### Task 1: Helper puro `classificarRealceDono`

**Files:**
- Create: `src/lib/call-session/owner-highlight.ts`
- Test: `src/lib/call-session/__tests__/owner-highlight.test.ts`

- [ ] **Step 1: Escrever o teste**

```ts
import { describe, it, expect } from 'vitest';
import { classificarRealceDono } from '../owner-highlight';

describe('classificarRealceDono', () => {
  it('cliente não identificado → desconhecido', () => {
    expect(classificarRealceDono({ ownerUserId: null, currentUserId: 'u1', customerUserId: null })).toBe('desconhecido');
  });
  it('cliente identificado mas sem dono na carteira → sem_dono', () => {
    expect(classificarRealceDono({ ownerUserId: null, currentUserId: 'u1', customerUserId: 'c1' })).toBe('sem_dono');
  });
  it('dono efetivo == usuário logado → meu', () => {
    expect(classificarRealceDono({ ownerUserId: 'u1', currentUserId: 'u1', customerUserId: 'c1' })).toBe('meu');
  });
  it('dono efetivo != usuário logado → outro', () => {
    expect(classificarRealceDono({ ownerUserId: 'u2', currentUserId: 'u1', customerUserId: 'c1' })).toBe('outro');
  });
  it('sem usuário logado mas com dono → outro (não pode ser "meu" sem saber quem sou)', () => {
    expect(classificarRealceDono({ ownerUserId: 'u2', currentUserId: null, customerUserId: 'c1' })).toBe('outro');
  });
});
```

- [ ] **Step 2: Rodar o teste — falha (módulo não existe)**

Run: `heavy bun run test -- owner-highlight`
Expected: FAIL ("Cannot find module '../owner-highlight'")

- [ ] **Step 3: Implementar o helper**

```ts
export type RealceDono = 'meu' | 'outro' | 'sem_dono' | 'desconhecido';

/**
 * Decide como destacar uma chamada entrante pra o usuário logado (Frente 1 degradada).
 * - desconhecido: cliente não identificado por telefone.
 * - sem_dono: cliente identificado mas sem dono efetivo na carteira (qualquer um atende).
 * - meu: o dono efetivo do cliente é o próprio usuário logado → destaque forte.
 * - outro: o cliente tem dono, e não sou eu → realce discreto ("cliente de X").
 */
export function classificarRealceDono(input: {
  ownerUserId: string | null;
  currentUserId: string | null;
  customerUserId: string | null;
}): RealceDono {
  if (!input.customerUserId) return 'desconhecido';
  if (!input.ownerUserId) return 'sem_dono';
  if (input.currentUserId && input.ownerUserId === input.currentUserId) return 'meu';
  return 'outro';
}
```

- [ ] **Step 4: Rodar o teste — passa**

Run: `heavy bun run test -- owner-highlight`
Expected: PASS (5 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-session/owner-highlight.ts src/lib/call-session/__tests__/owner-highlight.test.ts
git commit -m "feat(telefonia): helper classificarRealceDono (Frente 1 degradada)"
```

---

### Task 2: Resolver o dono no `IncomingCallModal` + renderizar o realce

**Files:**
- Modify: `src/components/call/IncomingCallModal.tsx`

- [ ] **Step 1: Importar o helper + `useAuth`**

No topo, após o import de `resolveCustomerByPhone`:

```tsx
import { classificarRealceDono, type RealceDono } from '@/lib/call-session/owner-highlight';
import { useAuth } from '@/contexts/AuthContext';
```

- [ ] **Step 2: Estado do realce + resolver o dono no `useEffect`**

Adicionar `const { user } = useAuth();` no início do componente (após `const ctx = ...`). Adicionar estado:

```tsx
  const [realce, setRealce] = useState<RealceDono>('desconhecido');
  const [donoNome, setDonoNome] = useState<string | null>(null);
```

Dentro do `useEffect`, no bloco que já tem `if (!resolved.customerUserId) return;`, **substituir** esse early-return e o que vem depois por (resolve cliente → dono efetivo → classifica):

```tsx
        if (!resolved.customerUserId) {
          if (!cancelled) setRealce('desconhecido');
          return;
        }

        const { data } = await supabase.from('profiles')
          .select('name, razao_social')
          .eq('user_id', resolved.customerUserId)
          .maybeSingle();
        if (!cancelled && data) {
          setResolvedCompany(data.razao_social || data.name);
        }

        // Frente 1 degradada: dono efetivo (com cobertura de férias) → realça meu/outro/sem-dono
        const { data: ownerId } = await supabase.rpc('wa_owner_efetivo', { p_customer: resolved.customerUserId });
        if (cancelled) return;
        const owner = (ownerId as string | null) ?? null;
        setRealce(classificarRealceDono({ ownerUserId: owner, currentUserId: user?.id ?? null, customerUserId: resolved.customerUserId }));
        if (owner && owner !== user?.id) {
          const { data: dono } = await supabase.from('profiles').select('name').eq('user_id', owner).maybeSingle();
          if (!cancelled && dono?.name) setDonoNome(dono.name);
        }
```

E no reset (quando `!incomingCall`), adicionar `setRealce('desconhecido'); setDonoNome(null);`.

Adicionar `user?.id` ao array de deps do `useEffect` (junto de `incomingCall`).

- [ ] **Step 3: Renderizar o realce no topo do `DialogDescription`**

Logo após `<DialogDescription className="space-y-2 pt-4">`, adicionar o banner de realce (antes do `primaryLabel`):

```tsx
            {realce === 'meu' && (
              <span className="block rounded-md bg-status-success-bg px-3 py-1.5 text-sm font-semibold text-status-success">
                ⭐ Seu cliente — atenda
              </span>
            )}
            {realce === 'outro' && (
              <span className="block rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
                Cliente {donoNome ? `da ${donoNome}` : 'de outra carteira'}
              </span>
            )}
```

- [ ] **Step 4: Typecheck + test + build**

Run: `heavy bun run typecheck && heavy bun run test -- owner-highlight && heavy bun run build`
Expected: PASS. (Se a RPC `wa_owner_efetivo` não estiver no `types.ts`, o `.rpc(...)` pode exigir cast — usar `supabase.rpc('wa_owner_efetivo' as never, { p_customer: ... } as never)` só se o typecheck reclamar.)

- [ ] **Step 5: Commit**

```bash
git add src/components/call/IncomingCallModal.tsx
git commit -m "feat(telefonia): destaca a dona da carteira no modal de chamada entrante"
```

---

## Self-Review

- **Spec coverage:** cobre §4.2 "destaque da dona no IncomingCallModal". Perdida/WhatsApp e config de fila estão marcados como não-objetivos (fases próprias). ✅
- **Placeholders:** nenhum — helper, teste e edições com código real.
- **Type consistency:** `RealceDono` e `classificarRealceDono({ownerUserId, currentUserId, customerUserId})` idênticos entre helper (Task 1) e uso (Task 2). ✅
- **Risco:** `IncomingCallModal` é componente de chamada; a mudança é aditiva (novo estado + 2 branches de UI), não toca o fluxo de atender/rejeitar. Degradação honesta: erro na RPC cai no `catch` existente → realce fica 'desconhecido' (sem destaque), modal funciona igual. ✅
