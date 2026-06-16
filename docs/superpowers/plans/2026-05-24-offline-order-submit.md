# Pedido Offline (submitOrder rascunho-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao vendedor offline um envio de pedido sem erro: offline salva rascunho (já existe) e um CTA manual "Enviar agora" dispara o `submitOrder` online ao reconectar — sem nunca enfileirar (evita PV duplicado no Omie).

**Architecture:** Hook fino `useOfflineSubmit` faz o gate em volta de `h.submitOrder` (offline → marca pendente + toast, não envia; online → envia). `UnifiedOrder` usa `useNetworkStatus` + o hook, passa estado `offline` pro `CartSummaryBar` (label do botão) e renderiza um banner com CTA quando reconecta com intent pendente. Sem migration, sem tocar `submitOrder`/Omie.

**Tech Stack:** React 18 + TypeScript + @tanstack/react-query + sonner + vitest. Reusa `useNetworkStatus` e `useOrderDraft` existentes.

**Spec base:** [docs/superpowers/specs/2026-05-24-offline-order-submit-design.md](../specs/2026-05-24-offline-order-submit-design.md)

**Baseline:** vitest 847 passed / 162 files (pós-merge do #250). Não regredir.

---

## File Structure

**Novos:**
```
src/hooks/useOfflineSubmit.ts                  # gate offline/online em volta do submit
src/hooks/__tests__/useOfflineSubmit.test.tsx  # 5 cenários
```

**Editados:**
```
src/components/unified-order/CartSummaryBar.tsx  # + prop offline; label do botão
src/pages/UnifiedOrder.tsx                       # useNetworkStatus + useOfflineSubmit + banner + props
```

---

### Task 1: Hook `useOfflineSubmit` (TDD)

**Files:**
- Create: `src/hooks/useOfflineSubmit.ts`
- Test: `src/hooks/__tests__/useOfflineSubmit.test.tsx`

- [ ] **Step 1: Escrever o teste falhando**

Create `src/hooks/__tests__/useOfflineSubmit.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { useOfflineSubmit } from '../useOfflineSubmit';

beforeEach(() => vi.clearAllMocks());

describe('useOfflineSubmit', () => {
  it('online: onSubmit chama submit', () => {
    const submit = vi.fn();
    const { result } = renderHook(() => useOfflineSubmit({ submit, online: true, hasContent: true }));
    act(() => result.current.onSubmit());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.offline).toBe(false);
    expect(result.current.showReconnectCta).toBe(false);
  });

  it('offline: onSubmit NÃO chama submit e marca offline', () => {
    const submit = vi.fn();
    const { result } = renderHook(() => useOfflineSubmit({ submit, online: false, hasContent: true }));
    act(() => result.current.onSubmit());
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.offline).toBe(true);
  });

  it('offline→online com intent pendente + conteúdo → mostra CTA de reconexão', () => {
    const submit = vi.fn();
    const { result, rerender } = renderHook(
      ({ online }: { online: boolean }) => useOfflineSubmit({ submit, online, hasContent: true }),
      { initialProps: { online: false } },
    );
    act(() => result.current.onSubmit()); // clica offline → pendente
    expect(result.current.showReconnectCta).toBe(false); // ainda offline
    rerender({ online: true }); // reconecta
    expect(result.current.showReconnectCta).toBe(true);
  });

  it('CTA de reconexão chama submit e some depois', () => {
    const submit = vi.fn();
    const { result, rerender } = renderHook(
      ({ online }: { online: boolean }) => useOfflineSubmit({ submit, online, hasContent: true }),
      { initialProps: { online: false } },
    );
    act(() => result.current.onSubmit());
    rerender({ online: true });
    expect(result.current.showReconnectCta).toBe(true);
    act(() => result.current.onReconnectSubmit());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.showReconnectCta).toBe(false);
  });

  it('sem conteúdo: nunca mostra CTA mesmo com intent pendente', () => {
    const submit = vi.fn();
    const { result, rerender } = renderHook(
      ({ online, hasContent }: { online: boolean; hasContent: boolean }) =>
        useOfflineSubmit({ submit, online, hasContent }),
      { initialProps: { online: false, hasContent: true } },
    );
    act(() => result.current.onSubmit());
    rerender({ online: true, hasContent: false });
    expect(result.current.showReconnectCta).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar → FAIL**

Run: `bun run vitest run src/hooks/__tests__/useOfflineSubmit.test.tsx`
Expected: FAIL — `Cannot find module '../useOfflineSubmit'`.

- [ ] **Step 3: Implementar**

Create `src/hooks/useOfflineSubmit.ts`:

```ts
import { useState, useCallback } from 'react';
import { toast } from 'sonner';

export interface UseOfflineSubmitOptions {
  /** Envio online real (ex: h.submitOrder). */
  submit: () => void | Promise<void>;
  /** Estado de rede (de useNetworkStatus). */
  online: boolean;
  /** Há conteúdo a enviar (cart > 0)? Gate o CTA de reconexão. */
  hasContent: boolean;
}

export interface UseOfflineSubmitReturn {
  /** Handler do botão de envio: offline → marca pendente + toast; online → submit(). */
  onSubmit: () => void;
  /** True quando offline (pra UI do botão). */
  offline: boolean;
  /** Mostra o banner de reconexão (online + intent offline pendente + tem conteúdo). */
  showReconnectCta: boolean;
  /** Handler do CTA "Enviar agora": limpa pendente + submit(). */
  onReconnectSubmit: () => void;
}

/**
 * Gate offline-first para o envio de pedido. Não enfileira (submitOrder cria PV cobrado
 * no Omie, não-idempotente). Offline: salva intent pendente + avisa (o rascunho já é
 * auto-salvo pelo useOrderDraft). Online de novo: expõe CTA pra enviar de verdade.
 */
export function useOfflineSubmit({ submit, online, hasContent }: UseOfflineSubmitOptions): UseOfflineSubmitReturn {
  const [pending, setPending] = useState(false);

  const onSubmit = useCallback(() => {
    if (!online) {
      setPending(true);
      toast.info('Sem conexão — salvo como rascunho. Enviaremos quando reconectar.');
      return;
    }
    setPending(false);
    void submit();
  }, [online, submit]);

  const onReconnectSubmit = useCallback(() => {
    setPending(false);
    void submit();
  }, [submit]);

  return {
    onSubmit,
    offline: !online,
    showReconnectCta: online && pending && hasContent,
    onReconnectSubmit,
  };
}
```

- [ ] **Step 4: Rodar → PASS**

Run: `bun run vitest run src/hooks/__tests__/useOfflineSubmit.test.tsx`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOfflineSubmit.ts src/hooks/__tests__/useOfflineSubmit.test.tsx
git commit -m "feat(offline): useOfflineSubmit (gate rascunho-first p/ envio de pedido, 5 tests)"
```

---

### Task 2: `CartSummaryBar` — prop `offline` + label do botão

**Files:**
- Modify: `src/components/unified-order/CartSummaryBar.tsx`

- [ ] **Step 1: Adicionar `CloudOff` ao import de ícones**

Trocar (linhas 10-12):
```ts
import {
  Send, Loader2, AlertCircle, Check, ChevronsUpDown, FileText, Calendar,
} from 'lucide-react';
```
por:
```ts
import {
  Send, Loader2, AlertCircle, Check, ChevronsUpDown, FileText, Calendar, CloudOff,
} from 'lucide-react';
```

- [ ] **Step 2: Adicionar a prop `offline` à interface**

Na `interface CartSummaryBarProps`, dentro do bloco `// Actions` (perto de `onSubmit`):
```ts
  // Actions
  onSubmit: () => void;
  onSubmitQuote?: () => void;
  /** Quando true, o botão vira "salvar rascunho" (vendedor offline). */
  offline?: boolean;
```

- [ ] **Step 3: Receber a prop na desestruturação do componente**

Trocar:
```ts
  onSubmit, onSubmitQuote,
}: CartSummaryBarProps) {
```
por:
```ts
  onSubmit, onSubmitQuote, offline = false,
}: CartSummaryBarProps) {
```

- [ ] **Step 4: Trocar o conteúdo do botão de envio por versão offline-aware**

Trocar (botão "Enviar pedido", ~linha 240-246):
```tsx
          <Button className="w-full gap-2" onClick={onSubmit} disabled={disableSubmit}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Enviar pedido
            {(() => {
              const count = (obenProductItems.length > 0 ? 1 : 0) + (colacorProductItems.length > 0 ? 1 : 0) + (serviceItems.length > 0 ? 1 : 0);
              return count > 1 ? <span className="text-[10px] opacity-70">({count} pedidos)</span> : null;
            })()}
          </Button>
```
por:
```tsx
          <Button className="w-full gap-2" onClick={onSubmit} disabled={disableSubmit}>
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : offline ? (
              <CloudOff className="w-4 h-4" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            {offline ? 'Sem conexão — salvar rascunho' : 'Enviar pedido'}
            {!offline && (() => {
              const count = (obenProductItems.length > 0 ? 1 : 0) + (colacorProductItems.length > 0 ? 1 : 0) + (serviceItems.length > 0 ? 1 : 0);
              return count > 1 ? <span className="text-[10px] opacity-70">({count} pedidos)</span> : null;
            })()}
          </Button>
```

> Nota: `disableSubmit` (submitting / serviço sem seleção / divergência de vendedor) continua valendo offline — são validações de negócio, não de rede. O botão de orçamento (`onSubmitQuote`) já depende de `submitting`; deixá-lo desabilitado offline fica fora do escopo (não é o fluxo principal).

- [ ] **Step 5: Validar lint**

Run: `bunx eslint src/components/unified-order/CartSummaryBar.tsx`
Expected: zero erros.

- [ ] **Step 6: Commit**

```bash
git add src/components/unified-order/CartSummaryBar.tsx
git commit -m "feat(offline): CartSummaryBar mostra 'salvar rascunho' quando offline"
```

---

### Task 3: Fiar no `UnifiedOrder` (hook + banner + props)

**Files:**
- Modify: `src/pages/UnifiedOrder.tsx`

- [ ] **Step 1: Imports**

Adicionar `Wifi` ao import de ícones (linha 2):
```ts
import { Loader2, ChevronLeft, CheckCircle, Building2, Scissors, Wifi } from 'lucide-react';
```

Adicionar (junto aos outros imports de hooks/components, ex. após a linha 15 `import { useAuth } ...`):
```ts
import { Button } from '@/components/ui/button';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useOfflineSubmit } from '@/hooks/useOfflineSubmit';
```

> Se `Button` já estiver importado no arquivo, não duplicar (conferir com `grep -n "components/ui/button" src/pages/UnifiedOrder.tsx`; se já houver, pular essa linha).

- [ ] **Step 2: Instanciar rede + gate (após o bloco do useOrderDraft, ~linha 78)**

Logo após o `const { draft, clear: clearDraft, dismiss: dismissDraft } = useOrderDraft({...});`:
```ts
  const net = useNetworkStatus();
  const offlineSubmit = useOfflineSubmit({
    submit: h.submitOrder,
    online: net.online,
    hasContent: h.cart.length > 0,
  });
```

- [ ] **Step 3: Banner de reconexão (logo após a abertura do container principal, antes do grid de conteúdo)**

Inserir imediatamente antes da linha `<div className={cn('grid gap-4', ...`:
```tsx
      {offlineSubmit.showReconnectCta && (
        <div className="rounded-md border border-status-info-bold/30 bg-status-info-bg px-4 py-3 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-status-info-bold">
            <Wifi className="w-4 h-4 shrink-0" />
            Conexão restabelecida. Seu pedido está salvo como rascunho.
          </div>
          <Button size="sm" onClick={offlineSubmit.onReconnectSubmit} disabled={h.submitting} className="shrink-0">
            Enviar pedido agora
          </Button>
        </div>
      )}
```

- [ ] **Step 4: Passar `onSubmit` (gate) + `offline` pro CartSummaryBar**

Trocar (no `<CartSummaryBar ... />`):
```tsx
              onSubmit={h.submitOrder}
              onSubmitQuote={h.submitQuote}
```
por:
```tsx
              onSubmit={offlineSubmit.onSubmit}
              onSubmitQuote={h.submitQuote}
              offline={offlineSubmit.offline}
```

- [ ] **Step 5: Validar lint + tipos + suíte**

Run:
```bash
bunx eslint src/pages/UnifiedOrder.tsx
bun run vitest run src/hooks/__tests__/useOfflineSubmit.test.tsx
```
Expected: zero erros de lint; 5/5 do hook.

- [ ] **Step 6: Commit**

```bash
git add src/pages/UnifiedOrder.tsx
git commit -m "feat(offline): UnifiedOrder usa useOfflineSubmit + banner de reconexão"
```

---

### Task 4: Validação final + QA + design-review

**Files:** nenhum (validação)

- [ ] **Step 1: Suíte + build limpos**

Run (sequencial, sem concorrência — CPU calma):
```bash
bun run test
bun run build
```
Expected: vitest 847 + 5 novos verdes; build exit 0.

- [ ] **Step 2: QA manual offline**

`bun dev` → logar → UnifiedOrder com cliente + itens no cart → DevTools → Offline →
1. Botão mostra "Sem conexão — salvar rascunho" (ícone CloudOff).
2. Clicar → toast "Sem conexão — salvo como rascunho..." (NÃO abre success dialog, NÃO chama Omie).
3. Network → Online → banner "Conexão restabelecida... Enviar pedido agora" aparece.
4. Clicar "Enviar pedido agora" → pedido criado normal (success dialog + recibo).
5. Online o tempo todo: botão "Enviar pedido" normal, envia direto (sem banner).

- [ ] **Step 3: `/design-review` nos estados offline**

Rodar `/design-review` (gstack) apontando pros estados: botão offline + banner de reconexão. Aplicar ajustes de espaçamento/hierarquia/contraste contra o design system v3 que ele apontar (commit separado se houver mudança).

- [ ] **Step 4: Push + PR (só com ok do founder)**

> Push/PR só com autorização explícita. Quando liberado:
```bash
git push -u origin claude/offline-order-submit
```
PR title: `feat(offline): pedido offline-first (rascunho + CTA de reconexão)`

---

## Critérios de "feito"

- [ ] `useOfflineSubmit` testado (online envia; offline não envia + marca; reconnect mostra CTA; CTA envia e some; sem conteúdo não mostra CTA).
- [ ] `CartSummaryBar` mostra "salvar rascunho" + ícone CloudOff quando offline.
- [ ] `UnifiedOrder` renderiza banner de reconexão e usa o gate.
- [ ] `submitOrder`/Omie inalterados; sem migration; sem enqueue.
- [ ] vitest verde (847 + 5); build exit 0.
- [ ] QA manual offline passou; `/design-review` aplicado.

## Out-of-scope (follow-up)

- Cross-sessão: persistir entrega/pagamento/volumes/ready-date no rascunho + restaurá-los (enviar após fechar/reabrir offline).
- Detecção de rede por timeout/heartbeat além de `navigator.onLine`.
- `submitQuote` offline; enqueue/idempotência de `submitOrder`.
