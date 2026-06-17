# Régua de Preço — UI no carrinho (PR3) · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar, na linha do carrinho Oben, um sinal de Régua de Preço (🔴 piso de MC / 💰 folga com evidência) que abre um popover com recibos + botão "Aplicar referência", sem criar um segundo vermelho conflitante com o cockpit de markup já existente.

**Architecture:** O núcleo (helper puro `avaliarReguaPreco` + RPC fetcher `get_regua_preco`) **já está pronto e provado** (PR1/PR2, no banco). Este PR é só a camada de UI + dados + log. `useReguaPreco` faz 1 `useQuery` que dispara a RPC N× via `Promise.allSettled` (fetcher — não depende do preço), e aplica o helper client-side via `useMemo` (re-roda a cada keystroke do preço, barato). O componente-pai (`CartItemList`) recebe um `Map<chave, ReguaPrecoResult>`, usa-o pra renderizar `<ReguaPrecoSinal>` por linha **e** pra suprimir o vermelho do cockpit quando `abaixoPiso` (a Régua é a autoridade do vermelho de margem). Log closed-loop via PostgREST direto (RLS staff): exibição qualificada (deduped + debounce 800ms) → `UPDATE` no aplicar.

**Tech Stack:** React 18 + TS strict · @tanstack/react-query (`useQuery` + `Promise.allSettled`) · shadcn `Popover` · sonner (não usado aqui) · vitest + @testing-library/react (jsdom) · Supabase PostgREST.

**Spec:** `docs/superpowers/specs/2026-06-15-regua-preco-design.md` §6 (UI), §7 (dados), §8 (log).

**Princípio-guia (Codex):** a ameaça central é a UI virar *autoridade prescritiva*. Travas: evidência visível **antes** da ação (Aplicar só dentro do popover), botão **ausente** em baixa/proxy/discordância (o helper já zera `precoReferencia`), **um único vermelho** pra MC<0, copy "referência" (nunca "ideal/recomendado").

---

## File Structure

| Arquivo | Responsabilidade | Tipo |
|---|---|---|
| `src/lib/regua-preco/regua-preco-ui.ts` | funções **puras**: `CAPS_REGUA`, tipos `FetchDataRegua`/`ReguaCartItem`/`ReguaItemFetch`, `dedupeFetchItens`, `montarInputRegua`, `chaveFetch` | Create |
| `src/lib/regua-preco/__tests__/regua-preco-ui.test.ts` | testes das puras (TDD) | Create |
| `src/hooks/useReguaPreco.ts` | `useQuery` + `Promise.allSettled` (fetch) → `useMemo` (aplica helper) → `{ reguaByKey, isLoading }` | Create |
| `src/hooks/__tests__/useReguaPreco.test.tsx` | dedupe + aplicação do helper (mock `supabase.rpc`) | Create |
| `src/components/regua-preco/ReguaPrecoSinal.tsx` | badge compacto + `Popover` (recibos + disclaimers + Aplicar) | Create |
| `src/components/regua-preco/__tests__/ReguaPrecoSinal.test.tsx` | render por sinal (piso/folga/baixa/nenhum) | Create |
| `src/lib/regua-preco/regua-preco-log.ts` | `registrarExibicaoRegua`/`registrarAplicacaoRegua` (PostgREST) | Create |
| `src/hooks/useReguaPrecoLog.ts` | dedupe client-side + `Map<chave,logId>` p/ o closed-loop | Create |
| `src/components/unified-order/CartItemList.tsx` | instanciar `useReguaPreco`, renderizar o sinal, **suprimir vermelho do cockpit**, wire Aplicar + log | Modify |
| `src/pages/UnifiedOrder.tsx:408-416` | passar `customerUserId={h.customerUserId}` | Modify |
| `src/hooks/useFeatureFlag.ts:17-19` | registrar `regua_preco_carrinho: false` no `DEFAULTS` (doc) | Modify |

---

## PR3 — UI no carrinho

### Task 1: Funções puras de transformação (TDD)

**Files:**
- Create: `src/lib/regua-preco/regua-preco-ui.ts`
- Test: `src/lib/regua-preco/__tests__/regua-preco-ui.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/regua-preco/__tests__/regua-preco-ui.test.ts
import { describe, it, expect } from 'vitest';
import { dedupeFetchItens, montarInputRegua, chaveFetch, CAPS_REGUA } from '../regua-preco-ui';
import type { FetchDataRegua, ReguaCartItem } from '../regua-preco-ui';

const item = (over: Partial<ReguaCartItem> = {}): ReguaCartItem => ({
  chave: 'oben:101:', productId: 'p1', qty: 2, precoAtual: 106, ...over,
});

describe('dedupeFetchItens', () => {
  it('colapsa mesmo (productId, qty) numa única busca', () => {
    const r = dedupeFetchItens([item(), item({ chave: 'oben:101:x' }), item({ productId: 'p2' })]);
    expect(r).toHaveLength(2);
    expect(r.map(chaveFetch).sort()).toEqual(['p1:2', 'p2:2']);
  });
  it('descarta itens sem productId, qty<=0 ou preço<=0', () => {
    expect(dedupeFetchItens([
      item({ productId: '' }), item({ qty: 0 }), item({ precoAtual: 0 }),
    ])).toHaveLength(0);
  });
});

describe('montarInputRegua', () => {
  const fetch: FetchDataRegua = {
    cmc: 98, cmc_confiavel: true, aliquota_venda: 0.078, piso_mc: 106.29,
    precos_cliente: [112, 110], comparaveis: [{ preco: 120, c: 1 }, { preco: 125, c: 2 }],
  };
  it('mapeia comparaveis {preco,c} → {preco,clienteId} e injeta CAPS', () => {
    const inp = montarInputRegua(fetch, 106);
    expect(inp.precoAtual).toBe(106);
    expect(inp.cmc).toBe(98);
    expect(inp.cmcConfiavel).toBe(true);
    expect(inp.aliquotaVenda).toBe(0.078);
    expect(inp.precosCliente).toEqual([112, 110]);
    expect(inp.comparaveis).toEqual([{ preco: 120, clienteId: '1' }, { preco: 125, clienteId: '2' }]);
    expect(inp.caps).toBe(CAPS_REGUA);
  });
  it('tolera arrays nulos vindos da RPC (degrada p/ vazio)', () => {
    const inp = montarInputRegua({ ...fetch, precos_cliente: null as never, comparaveis: null as never }, 106);
    expect(inp.precosCliente).toEqual([]);
    expect(inp.comparaveis).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test -- regua-preco-ui`
Expected: FAIL — "Cannot find module '../regua-preco-ui'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/regua-preco/regua-preco-ui.ts
import type { ReguaPrecoInput } from './types';

/** Cap conservador de aumento por confiança da evidência (calibrável; constante no v1). */
export const CAPS_REGUA = { alta: 0.1, media: 0.05 } as const;

/** Retorno cru da RPC `get_regua_preco` (jsonb). */
export interface FetchDataRegua {
  cmc: number | null;
  cmc_confiavel: boolean;
  aliquota_venda: number;
  piso_mc: number | null;
  precos_cliente: number[];
  comparaveis: { preco: number; c: number }[]; // c = cliente anonimizado (dense_rank)
}

/** Linha do carrinho relevante p/ a Régua. `chave` casa com o cockpit (chaveCockpit). */
export interface ReguaCartItem {
  chave: string;
  productId: string;
  qty: number;
  precoAtual: number;
}

/** Item já deduplicado p/ o fetch (1 RPC por par produto+quantidade). */
export interface ReguaItemFetch {
  productId: string;
  qty: number;
}

/** Chave estável produto+qty — casa item do carrinho ↔ resultado do fetch. */
export const chaveFetch = (i: ReguaItemFetch): string => `${i.productId}:${i.qty}`;

/** Gates + dedupe: só busca itens válidos, 1 vez por (productId, qty). */
export function dedupeFetchItens(itens: ReguaCartItem[]): ReguaItemFetch[] {
  const seen = new Set<string>();
  const out: ReguaItemFetch[] = [];
  for (const it of itens) {
    if (!it.productId || !(it.qty > 0) || !(it.precoAtual > 0)) continue;
    const k = `${it.productId}:${it.qty}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ productId: it.productId, qty: it.qty });
  }
  return out;
}

/** Monta o input do helper a partir do fetch da RPC + o preço atual da linha. */
export function montarInputRegua(fetch: FetchDataRegua, precoAtual: number): ReguaPrecoInput {
  return {
    precoAtual,
    cmc: fetch.cmc,
    cmcConfiavel: fetch.cmc_confiavel,
    aliquotaVenda: fetch.aliquota_venda,
    precosCliente: fetch.precos_cliente ?? [],
    comparaveis: (fetch.comparaveis ?? []).map((c) => ({ preco: c.preco, clienteId: String(c.c) })),
    caps: CAPS_REGUA,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test -- regua-preco-ui`
Expected: PASS (todos verdes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/regua-preco/regua-preco-ui.ts src/lib/regua-preco/__tests__/regua-preco-ui.test.ts
git commit -m "feat(regua-preco): puras de transformação fetch→input + dedupe (PR3)"
```

---

### Task 2: Hook `useReguaPreco` (fetch N× paralelo + aplica helper)

**Files:**
- Create: `src/hooks/useReguaPreco.ts`
- Test: `src/hooks/__tests__/useReguaPreco.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/__tests__/useReguaPreco.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-real' } }) }));

import { useReguaPreco } from '../useReguaPreco';
import type { ReguaCartItem } from '@/lib/regua-preco/regua-preco-ui';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const FETCH_PISO = { cmc: 98, cmc_confiavel: true, aliquota_venda: 0.078, piso_mc: 106.29,
  precos_cliente: [], comparaveis: [] };

describe('useReguaPreco', () => {
  beforeEach(() => rpcMock.mockReset());

  it('aplica o helper: preço abaixo do piso de MC → sinal piso', async () => {
    rpcMock.mockResolvedValue({ data: FETCH_PISO, error: null });
    const itens: ReguaCartItem[] = [{ chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 }];
    const { result } = renderHook(() => useReguaPreco(itens, 'cust-1', true), { wrapper });
    await waitFor(() => expect(result.current.reguaByKey.get('k1')).toBeDefined());
    expect(result.current.reguaByKey.get('k1')!.sinal).toBe('piso');
    expect(result.current.reguaByKey.get('k1')!.abaixoPiso).toBe(true);
  });

  it('dedup: dois itens mesmo (produto,qty) disparam 1 só RPC', async () => {
    rpcMock.mockResolvedValue({ data: FETCH_PISO, error: null });
    const itens: ReguaCartItem[] = [
      { chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 },
      { chave: 'k2', productId: 'p1', qty: 2, precoAtual: 100 },
    ];
    renderHook(() => useReguaPreco(itens, 'cust-1', true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
  });

  it('flag off ou sem cliente → não chama RPC', async () => {
    const itens: ReguaCartItem[] = [{ chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 }];
    renderHook(() => useReguaPreco(itens, null, true), { wrapper });
    renderHook(() => useReguaPreco(itens, 'cust-1', false), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test -- useReguaPreco`
Expected: FAIL — "Cannot find module '../useReguaPreco'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/hooks/useReguaPreco.ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { avaliarReguaPreco } from '@/lib/regua-preco/regua-preco-helpers';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';
import {
  dedupeFetchItens, montarInputRegua, chaveFetch,
  type ReguaCartItem, type FetchDataRegua,
} from '@/lib/regua-preco/regua-preco-ui';

type RpcResult = { data: FetchDataRegua | null; error: unknown };
const callRpc = (args: { p_customer: string; p_product: string; p_qty: number }) =>
  (supabase.rpc as never as (fn: string, a: typeof args) => Promise<RpcResult>)('get_regua_preco', args);

/**
 * Régua de Preço por linha do carrinho. 1 useQuery dispara a RPC fetcher N× em
 * paralelo (Promise.allSettled — isola item lento/falho); a decisão roda no helper
 * client-side (useMemo) a cada mudança de preço, SEM re-buscar (queryKey não tem preço).
 * queryKey inclui o user.id REAL (anti-leak entre usuários no mesmo browser).
 */
export function useReguaPreco(itens: ReguaCartItem[], customerUserId: string | null, enabled: boolean) {
  const { user } = useAuth();
  const fetchItens = useMemo(() => dedupeFetchItens(itens), [itens]);
  const fetchKeysSig = fetchItens.map(chaveFetch).join(',');

  const query = useQuery({
    queryKey: ['regua-preco', user?.id ?? 'anon', customerUserId, fetchKeysSig],
    enabled: enabled && !!customerUserId && fetchItens.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, FetchDataRegua>> => {
      const settled = await Promise.allSettled(
        fetchItens.map((f) => callRpc({ p_customer: customerUserId!, p_product: f.productId, p_qty: f.qty })),
      );
      const m = new Map<string, FetchDataRegua>();
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value.data) m.set(chaveFetch(fetchItens[i]), res.value.data);
      });
      return m;
    },
  });

  const reguaByKey = useMemo(() => {
    const out = new Map<string, ReguaPrecoResult>();
    const fetchMap = query.data;
    if (!fetchMap) return out;
    for (const it of itens) {
      const fd = fetchMap.get(`${it.productId}:${it.qty}`);
      if (!fd) continue;
      out.set(it.chave, avaliarReguaPreco(montarInputRegua(fd, it.precoAtual)));
    }
    return out;
  }, [itens, query.data]);

  return { reguaByKey, isLoading: query.isLoading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test -- useReguaPreco`
Expected: PASS (3 testes verdes).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useReguaPreco.ts src/hooks/__tests__/useReguaPreco.test.tsx
git commit -m "feat(regua-preco): hook useReguaPreco (fetch N× paralelo + helper client-side)"
```

---

### Task 3: Componente `ReguaPrecoSinal` (badge + popover)

**Files:**
- Create: `src/components/regua-preco/ReguaPrecoSinal.tsx`
- Test: `src/components/regua-preco/__tests__/ReguaPrecoSinal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/regua-preco/__tests__/ReguaPrecoSinal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReguaPrecoSinal } from '../ReguaPrecoSinal';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';

const base: ReguaPrecoResult = {
  sinal: 'nenhum', confianca: 'oculto', precoReferencia: null, observedGapPct: null,
  suggestedGapPct: null, pisoMC: null, abaixoPiso: false, capLimitou: false,
  discordancia: false, recibos: [], disclaimers: [], reasonCodes: [],
};
const ctx = { produto: 'Verniz PU', cliente: 'Marcenaria Silva', qty: 2 };
const noop = () => {};

describe('ReguaPrecoSinal', () => {
  it('sinal nenhum → não renderiza nada', () => {
    const { container } = render(<ReguaPrecoSinal result={base} precoAtual={120} contexto={ctx} onAplicar={noop} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('piso com CMC confiável → badge vermelho com o piso (botão existe no popover)', () => {
    const r: ReguaPrecoResult = { ...base, sinal: 'piso', confianca: 'alta', abaixoPiso: true,
      precoReferencia: 106.29, pisoMC: 106.29, recibos: ['Custo+imposto ≈ piso R$ 106,29'] };
    render(<ReguaPrecoSinal result={r} precoAtual={100} contexto={ctx} onAplicar={noop} />);
    expect(screen.getByText(/MC<0/)).toBeInTheDocument();
  });
  it('folga baixa (sem precoReferencia) → não mostra número de ação', () => {
    const r: ReguaPrecoResult = { ...base, sinal: 'auto_ref', confianca: 'baixa',
      precoReferencia: null, recibos: ['Este cliente já pagou mais (amostra pequena).'] };
    render(<ReguaPrecoSinal result={r} precoAtual={100} contexto={ctx} onAplicar={noop} />);
    expect(screen.queryByText(/Aplicar/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test -- ReguaPrecoSinal`
Expected: FAIL — "Cannot find module '../ReguaPrecoSinal'".

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/regua-preco/ReguaPrecoSinal.tsx
import { useEffect } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fmt } from '@/hooks/useUnifiedOrder';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';

interface ReguaPrecoSinalProps {
  result: ReguaPrecoResult;
  precoAtual: number;
  contexto: { produto: string; cliente: string | null; qty: number };
  onAplicar: (preco: number) => void;
  /** chamado quando o sinal está visível ≥800ms (debounce) — log de exibição. */
  onExibido?: (result: ReguaPrecoResult) => void;
}

export function ReguaPrecoSinal({ result, precoAtual, contexto, onAplicar, onExibido }: ReguaPrecoSinalProps) {
  const ehPiso = result.sinal === 'piso';
  const ehFolga = result.sinal === 'auto_ref' || result.sinal === 'benchmark';
  const visivel = ehPiso || ehFolga; // nenhum/discordância/preço-acima = invisível
  const temBotao = result.precoReferencia != null; // helper já zera em proxy/baixa/discordância
  const pct = result.suggestedGapPct != null ? Math.round(result.suggestedGapPct * 100) : 0;

  useEffect(() => {
    if (!visivel || !onExibido) return;
    const t = setTimeout(() => onExibido(result), 800);
    return () => clearTimeout(t);
    // re-dispara o debounce se o sinal/alvo mudar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visivel, result.sinal, result.precoReferencia]);

  if (!visivel) return null;

  const cls = ehPiso ? 'text-status-error border-status-error/40' : 'text-status-info border-status-info/40';
  const label = ehPiso
    ? (temBotao ? `MC<0 · piso ${fmt(result.precoReferencia!)}` : 'MC<0 · confira custo')
    : (temBotao ? `💰 ${fmt(result.precoReferencia!)} (+${pct}%)` : '💰 ⓘ');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn('inline-flex items-center rounded border px-1 py-0 text-[9px] font-medium leading-none', cls)}
          aria-label="Detalhes da Régua de Preço"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-xs space-y-1.5">
        <p className="font-medium leading-tight">
          {contexto.produto}{contexto.cliente ? ` · ${contexto.cliente}` : ''} · {contexto.qty}un
        </p>
        {temBotao && (
          <p className="text-muted-foreground">
            Você: {fmt(precoAtual)}/un · Referência: <span className="font-mono">{fmt(result.precoReferencia!)}/un</span>
          </p>
        )}
        {result.recibos.map((r, i) => (
          <p key={i} className="text-muted-foreground leading-snug">{r}</p>
        ))}
        {result.disclaimers.length > 0 && (
          <p className="text-[10px] text-muted-foreground/80 leading-snug border-t pt-1">
            ⓘ {result.disclaimers.join(' · ')}
          </p>
        )}
        {temBotao && (
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-xs"
            onClick={() => onAplicar(result.precoReferencia!)}
          >
            {ehPiso ? 'Aplicar piso' : 'Aplicar referência'} · {fmt(result.precoReferencia!)}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test -- ReguaPrecoSinal`
Expected: PASS (3 testes verdes).

- [ ] **Step 5: Commit**

```bash
git add src/components/regua-preco/ReguaPrecoSinal.tsx src/components/regua-preco/__tests__/ReguaPrecoSinal.test.tsx
git commit -m "feat(regua-preco): componente ReguaPrecoSinal (badge + popover, evidência antes da ação)"
```

---

### Task 4: Integração no carrinho + supressão do vermelho do cockpit + flag

**Files:**
- Modify: `src/components/unified-order/CartItemList.tsx`
- Modify: `src/pages/UnifiedOrder.tsx:408-416`
- Modify: `src/hooks/useFeatureFlag.ts:17-19`

- [ ] **Step 1: Registrar a flag (default sombra = off)**

Em `src/hooks/useFeatureFlag.ts`, no objeto `DEFAULTS` (linhas 17-19), acrescentar a entrada:

```ts
const DEFAULTS: Record<string, boolean> = {
  newVisual: true, // Novo visual ativo por padrão (rollout completo)
  regua_preco_carrinho: false, // Régua de Preço no carrinho — sombra→balcão (off por padrão)
};
```

- [ ] **Step 2: Passar `customerUserId` ao CartItemList**

Em `src/pages/UnifiedOrder.tsx`, na instanciação (linha 408-416), acrescentar a prop:

```tsx
          <CartItemList
            cart={h.cart} obenProductItems={h.obenProductItems} colacorProductItems={h.colacorProductItems}
            serviceItems={h.serviceItems} obenSubtotal={h.obenSubtotal} colacorProdSubtotal={h.colacorProdSubtotal}
            serviceSubtotal={h.serviceSubtotal} totalEstimated={h.totalEstimated}
            deliveryOption={h.deliveryOption} selectedTimeSlot={h.selectedTimeSlot}
            onUpdateQuantity={h.updateQuantity} onUpdateProductPrice={h.updateProductPrice}
            onRemoveFromCart={h.removeFromCart} getServicePrice={h.getServicePrice}
            getCartIndex={(item) => h.cart.indexOf(item)}
            customerUserId={h.customerUserId}
            customerName={h.selectedCustomer?.razao_social ?? null}
          />
```

- [ ] **Step 3: CartItemList — nova prop + hook + render do sinal + supressão do cockpit**

Em `src/components/unified-order/CartItemList.tsx`:

(a) Imports (após a linha 15, junto aos demais `@/`):
```ts
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { useReguaPreco } from '@/hooks/useReguaPreco';
import { ReguaPrecoSinal } from '@/components/regua-preco/ReguaPrecoSinal';
import type { ReguaCartItem } from '@/lib/regua-preco/regua-preco-ui';
```

(b) Na interface `CartItemListProps` (após `getCartIndex`, linha 32), adicionar:
```ts
  customerUserId: string | null;
  customerName: string | null;
```

(c) Na desestruturação dos props (linha 35-41), adicionar `customerUserId, customerName,`.

(d) Após o bloco do cockpit (`cockpitByKey`, termina na linha 64), acrescentar o hook da Régua (só Oben no v1):
```ts
  const [reguaFlag] = useFeatureFlag('regua_preco_carrinho');
  const reguaItens = useMemo<ReguaCartItem[]>(() =>
    obenProductItems.map((it) => ({
      chave: chaveCockpit(it.product.account ?? '', it.product.omie_codigo_produto, it.tint_formula_id),
      productId: it.product.id,
      qty: it.quantity,
      precoAtual: it.unit_price,
    })),
    [obenProductItems],
  );
  const { reguaByKey } = useReguaPreco(reguaItens, customerUserId, reguaFlag);
```

(e) Dentro de `renderProductGroup`, no `.map(item => {...})` (após `const health = ...`, linha 73), obter o resultado da Régua e o flag de supressão:
```ts
        const chave = chaveCockpit(item.product.account ?? '', item.product.omie_codigo_produto, item.tint_formula_id);
        const regua = reguaByKey.get(chave);
        const reguaVermelho = regua?.sinal === 'piso'; // Régua = autoridade do vermelho de margem
        const cockpitSuprimido = reguaVermelho && health?.faixa === 'vermelho';
```
(reaproveite `chave` no lugar da chamada `chaveCockpit(...)` já existente na linha 73).

(f) **Substituir** o bloco do badge do cockpit (linhas 86-101) por um container flex único — o badge do cockpit (recuado a neutro quando suprimido) **e** o sinal da Régua lado a lado, sem duplicação. Cada um é condicional; o container aparece se houver qualquer um dos dois:
```tsx
                {((health && health.faixa !== 'neutro' && FAIXA_UI[health.faixa]) || regua) && (
                  <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                    {health && health.faixa !== 'neutro' && FAIXA_UI[health.faixa] && (
                      <Badge
                        variant="outline"
                        className={cn('text-[9px] px-1 py-0', cockpitSuprimido ? 'text-muted-foreground border-border' : FAIXA_UI[health.faixa].cls)}
                        title={health.cmc != null ? 'Markup bruto sobre o custo (CMC) — não inclui imposto/comissão/frete/prazo' : undefined}
                      >
                        {cockpitSuprimido ? '' : FAIXA_UI[health.faixa].label}
                        {health.cmc != null && health.markup_perc != null && (
                          <span className={cn('font-mono', !cockpitSuprimido && 'ml-1')}>
                            {Math.round(health.markup_perc)}%{health.folga_reais != null ? ` · ${fmt(health.folga_reais)}` : ''}
                          </span>
                        )}
                      </Badge>
                    )}
                    {regua && (
                      <ReguaPrecoSinal
                        result={regua}
                        precoAtual={item.unit_price}
                        contexto={{ produto: item.product.descricao, cliente: customerName, qty: item.quantity }}
                        onAplicar={(preco) => onUpdateProductPrice(cartIdx, preco)}
                      />
                    )}
                  </div>
                )}
```

- [ ] **Step 4: Typecheck + lint**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "tc=$?"; heavy bun run lint > /tmp/lint.log 2>&1; echo "lint=$?"`
Expected: `tc=0` e `lint=0`. Se `lint` apontar `no-restricted-syntax` ou import order, corrigir conforme a regra.

- [ ] **Step 5: Commit**

```bash
git add src/components/unified-order/CartItemList.tsx src/pages/UnifiedOrder.tsx src/hooks/useFeatureFlag.ts
git commit -m "feat(regua-preco): integra sinal no carrinho + suprime vermelho do cockpit + flag sombra"
```

---

### Task 5: Closed-loop log (exibição qualificada + aplicação) via PostgREST

**Files:**
- Create: `src/lib/regua-preco/regua-preco-log.ts`
- Create: `src/hooks/useReguaPrecoLog.ts`
- Modify: `src/components/unified-order/CartItemList.tsx` (wire)

- [ ] **Step 1: Funções de gravação (PostgREST direto, RLS staff)**

```ts
// src/lib/regua-preco/regua-preco-log.ts
import { supabase } from '@/integrations/supabase/client';
import type { ReguaPrecoResult } from './types';

export interface ExibicaoReguaPayload {
  account: string;
  customerUserId: string;
  productId: string;
  salespersonId: string;
  quantity: number;
  precoAtual: number;
  cmcUsado: number | null;
  result: ReguaPrecoResult;
}

/** INSERT 'pendente' da exibição qualificada. Falha de log NUNCA derruba o carrinho. */
export async function registrarExibicaoRegua(p: ExibicaoReguaPayload): Promise<string | null> {
  const r = p.result;
  const { data, error } = await supabase
    .from('regua_preco_log')
    .insert({
      account: p.account,
      customer_user_id: p.customerUserId,
      product_id: p.productId,
      salesperson_id: p.salespersonId,
      quantity: p.quantity,
      preco_atual: p.precoAtual,
      sinal_exibido: r.sinal,
      confianca: r.confianca,
      preco_referencia: r.precoReferencia,
      observed_gap_pct: r.observedGapPct,
      suggested_gap_pct: r.suggestedGapPct,
      piso_mc: r.pisoMC,
      cap_limitou: r.capLimitou,
      cmc_usado: p.cmcUsado,
      cmc_confianca: r.reasonCodes.includes('cmc_proxy') ? 'proxy' : 'real',
      reason_codes: r.reasonCodes,
      outcome_status: 'pendente',
      aplicou: false,
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[regua] log exibição falhou (ignorado):', error);
    return null;
  }
  return data?.id ?? null;
}

/** UPDATE → 'aplicado' quando o vendedor clica Aplicar. */
export async function registrarAplicacaoRegua(logId: string, precoFinal: number): Promise<void> {
  const { error } = await supabase
    .from('regua_preco_log')
    .update({ preco_final: precoFinal, aplicou: true, outcome_status: 'aplicado', outcome_at: new Date().toISOString() })
    .eq('id', logId);
  if (error) console.warn('[regua] log aplicação falhou (ignorado):', error);
}
```

- [ ] **Step 2: Hook de orquestração (dedupe client-side + Map chave→logId)**

```ts
// src/hooks/useReguaPrecoLog.ts
import { useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { registrarExibicaoRegua, registrarAplicacaoRegua, type ExibicaoReguaPayload } from '@/lib/regua-preco/regua-preco-log';

type DadosExibicao = Omit<ExibicaoReguaPayload, 'salespersonId'>;

/**
 * Closed-loop da Régua. Dedup por (chave + sinal + precoReferencia): cada combinação
 * loga UMA vez por montagem do carrinho. Guarda o logId p/ casar o UPDATE no Aplicar.
 */
export function useReguaPrecoLog() {
  const { user } = useAuth();
  const logIds = useRef(new Map<string, string>());   // chaveItem → logId (último exibido)
  const jaLogado = useRef(new Set<string>());          // chave dedupe

  const marcarExibido = useCallback(async (chaveItem: string, dados: DadosExibicao) => {
    if (!user?.id) return;
    const dedupeKey = `${chaveItem}:${dados.result.sinal}:${dados.result.precoReferencia}`;
    if (jaLogado.current.has(dedupeKey)) return;
    jaLogado.current.add(dedupeKey);
    const id = await registrarExibicaoRegua({ ...dados, salespersonId: user.id });
    if (id) logIds.current.set(chaveItem, id);
  }, [user?.id]);

  const marcarAplicado = useCallback((chaveItem: string, precoFinal: number) => {
    const id = logIds.current.get(chaveItem);
    if (id) void registrarAplicacaoRegua(id, precoFinal);
  }, []);

  return { marcarExibido, marcarAplicado };
}
```

- [ ] **Step 3: Wire no CartItemList**

(a) Import: `import { useReguaPrecoLog } from '@/hooks/useReguaPrecoLog';`

(b) Após o `useReguaPreco(...)` (Task 4 passo d), instanciar: `const { marcarExibido, marcarAplicado } = useReguaPrecoLog();`

(c) Na instância de `<ReguaPrecoSinal>` (Task 4 passo f), passar `onExibido` e enriquecer `onAplicar` (substituem o `onAplicar` simples do passo f):
```tsx
                        onExibido={(r) => marcarExibido(chave, {
                          account: 'oben', customerUserId: customerUserId!, productId: item.product.id,
                          quantity: item.quantity, precoAtual: item.unit_price,
                          cmcUsado: health?.cmc ?? null, result: r,
                        })}
                        onAplicar={(preco) => { onUpdateProductPrice(cartIdx, preco); marcarAplicado(chave, preco); }}
```
(o `onExibido` só dispara quando `customerUserId` existe, pois o sinal só aparece com a Régua habilitada, que exige cliente).

- [ ] **Step 4: Typecheck + test + lint**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "tc=$?"; heavy bun run test > /tmp/t.log 2>&1; echo "test=$?"; heavy bun run lint > /tmp/l.log 2>&1; echo "lint=$?"`
Expected: `tc=0`, `test=0`, `lint=0`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/regua-preco/regua-preco-log.ts src/hooks/useReguaPrecoLog.ts src/components/unified-order/CartItemList.tsx
git commit -m "feat(regua-preco): closed-loop log (exibição qualificada → aplicação) via PostgREST"
```

---

### Task 6: Verificação manual em modo sombra (founder)

**Files:** nenhum (verificação).

- [ ] **Step 1:** `bun dev`, logar como staff, selecionar um cliente Oben com histórico, adicionar um SKU ao carrinho.
- [ ] **Step 2:** No console do browser: `localStorage.setItem('feature_flag_regua_preco_carrinho','1'); location.reload()`.
- [ ] **Step 3:** Conferir: (a) item abaixo do piso de MC mostra `MC<0 · piso R$ X` em vermelho **e o badge do cockpit recua a neutro** (sem segundo vermelho); (b) item com folga e ≥média mostra `💰 R$ Y (+Z%)`; (c) clicar abre o popover com recibos + disclaimers; (d) "Aplicar referência" preenche o campo de preço; (e) item sem evidência não mostra nada.
- [ ] **Step 4:** Validar o log (read-only, EU rodo via `psql-ro`):
```sql
SELECT sinal_exibido, confianca, preco_referencia, outcome_status, aplicou, reason_codes
FROM public.regua_preco_log ORDER BY created_at DESC LIMIT 10;
```
Esperado: linhas `pendente` na exibição; `aplicado` + `preco_final` após clicar Aplicar.
- [ ] **Step 5:** Desligar a flag: `localStorage.removeItem('feature_flag_regua_preco_carrinho')` — a Régua some, o carrinho volta ao normal (sem regressão).

---

## Self-Review

**1. Spec coverage:**
- §6 princípio-guia (autoridade prescritiva) → Task 3 (botão só no popover, copy "referência", helper zera botão em baixa) ✅
- §6.1 coexistência cockpit (Régua autoridade do vermelho) → Task 4 passo f (`cockpitSuprimido`) ✅
- §6.2 anatomia badge→popover → Task 3 ✅
- §6.3 travas (evidência antes da ação, não-destrutivo, botão ausente, copy neutra, flag) → Tasks 3+4 ✅
- §7 dados (1 useQuery + Promise.allSettled, gates, dedupe, user.id real) → Task 2 ✅
- §8 log (exibição qualificada deduped + debounce 800ms → UPDATE aplicado; reason_codes sempre) → Tasks 3 (debounce) + 5 (dedupe+insert+update) ✅

**2. Placeholder scan:** sem TBD/TODO; todo passo com código real ou diff exato. O único símbolo a trocar é o placeholder `（）`→`()` no passo 4f (avisado inline). ✅

**3. Type consistency:** `FetchDataRegua`/`ReguaCartItem`/`chaveFetch` definidos na Task 1 e usados idênticos nas Tasks 2/4. `ReguaPrecoResult` (campos `sinal`/`precoReferencia`/`abaixoPiso`/`recibos`/`disclaimers`/`reasonCodes`/`suggestedGapPct`/`capLimitou`) consumidos conforme `types.ts`. `onAplicar(preco:number)`/`onExibido(result)` consistentes entre Task 3 (def) e Tasks 4/5 (uso). ✅

**Escopo NÃO incluído (deferido, explícito):** RPC `SECURITY DEFINER` de gravação (hardening pós-sombra — v1 grava via PostgREST/RLS staff); RPC batch `get_regua_preco_carrinho` (só se latência p95 estourar); PR4 (Customer 360 herda `ReguaPrecoSinal`); randomização anti-viés do log (v2).
