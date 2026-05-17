# PR5 — Histórico do Cliente UI + Perfil 360 (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar visível no app tudo que o PR4 está salvando em `farmer_calls`. Adicionar aba **"Chamadas"** em `/admin/customers/:customerId` com timeline de chamadas (transcript expandido, análises do copilot, entidades extraídas). Sumário **Perfil 360 v1** no topo (KPIs agregados + concorrentes citados + objeções recorrentes). Página separada **"Chamadas pendentes de vínculo"** pra rascunhos auto-salvos sem `customer_user_id` — vendedor vincula com 1 clique.

**Architecture:** 100% client-side (lê `farmer_calls` via supabase client). Sem novas tabelas, sem edge functions, sem migrations. 1 hook de query (`useCustomerCalls`), 4 componentes presentacionais (`CustomerProfile360Summary`, `CustomerCallsTab`, `CallSessionRow`, `CallSessionDetail`), 1 hook mutativo (`useLinkCallToCustomer`), 1 página nova (`FarmerCallsPendingLink`). Integração no `AdminCustomers.tsx` é cirúrgica: adiciona 1 tab + 1 bloco no header.

**Tech Stack:** React Query (`@tanstack/react-query` já no projeto) · shadcn (Tabs, Card, Badge, Sheet ou Dialog pra expand) · `date-fns` (formatação relativa) · Vitest 3.2 (helpers puros TDD) · supabase-js (queries diretas com RLS já configurada).

**Não-objetivos (futuros):**
- Edição manual de transcript/analyses (read-only nesta v1; PR posterior se justificar)
- Multi-categoria com mapeamento Oben/Colacor abrasivos (vai pro Perfil 360 v2 — PR9 ou depois)
- Cálculo de gap potencial vs realizado (precisa Omie consolidado — PR10)
- Filtros avançados na lista (data range, vendedor, outcome) — começa sem; adicionar quando vendedor pedir
- Export CSV/PDF — fora de escopo
- Reanálise SPIN retrospectiva (rodar copilot em transcript salvo) — interessante mas é outro PR
- UI de re-vincular cliente já vinculado (só vincula NULL → user_id; mudar vínculo fica pra PR de admin)

---

## File Structure

**Criar:**
- `src/hooks/__tests__/useCustomerCalls.test.tsx` — testes do hook de query
- `src/hooks/useCustomerCalls.ts` — query React Query: chamadas com transcript ≠ null por customerId, ordenadas DESC
- `src/hooks/useLinkCallToCustomer.ts` — mutation UPDATE customer_user_id em farmer_calls
- `src/lib/call-session/aggregate-customer-profile.ts` — pure helper que agrega farmer_calls[] → KPIs + entidades + objeções
- `src/lib/call-session/aggregate-customer-profile.test.ts` — testes
- `src/components/customer/CustomerProfile360Summary.tsx` — bloco no topo de AdminCustomers detail
- `src/components/customer/CustomerCallsTab.tsx` — content da tab "Chamadas"
- `src/components/customer/CallSessionRow.tsx` — 1 linha da timeline (clica → expand)
- `src/components/customer/CallSessionDetail.tsx` — modal/sheet expand: transcript + analyses + entities
- `src/pages/FarmerCallsPendingLink.tsx` — página `/farmer/calls/pending-link`

**Modificar:**
- `src/pages/AdminCustomers.tsx` — adicionar 1 tab "Chamadas" + render do `<CustomerProfile360Summary>` no detail view
- `src/App.tsx` — adicionar rota `/farmer/calls/pending-link` (lazy)
- `src/components/AppShell.tsx` — adicionar item de menu "Chamadas pendentes" na seção Farmer (badge com count se > 0)

**Não modificar:**
- `src/pages/FarmerCalls.tsx` (form manual continua igual — vendedor edita revenue/notes pelo form existente, agora opcionalmente após auto-save)
- Backend (RLS já cobre: vendedor vê suas, master vê todas — get-only)
- Schema banco

---

## Pré-requisito do operador

- PR #59 (PR4) merged em main (caso contrário a tabela tem as colunas mas o código não salva nada → UI vai mostrar tabela vazia, o que é apenas estética).
- Nenhuma config nova. Tudo usa supabase já configurado.

---

## Task 1: Hook `useCustomerCalls` (TDD)

**Files:**
- Create: `src/hooks/useCustomerCalls.ts`
- Create: `src/hooks/__tests__/useCustomerCalls.test.tsx`

**Comportamento:**
- `useCustomerCalls(customerId: string | null)` → React Query hook
- Quando `customerId === null` → `enabled: false` (não faz query)
- Query: `SELECT * FROM farmer_calls WHERE customer_user_id = $1 AND transcript IS NOT NULL ORDER BY started_at DESC LIMIT 50`
- `staleTime: 60_000`, `gcTime: 5min`
- Retorna `{ data, isLoading, error }`

- [ ] **Step 1: Testes**

```tsx
// src/hooks/__tests__/useCustomerCalls.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { fromMock, orderMock, eqMock, notMock, limitMock, selectMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  eqMock: vi.fn(),
  notMock: vi.fn(),
  orderMock: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

import { useCustomerCalls } from '../useCustomerCalls';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    select: selectMock.mockReturnThis(),
    eq: eqMock.mockReturnThis(),
    not: notMock.mockReturnThis(),
    order: orderMock.mockReturnThis(),
    limit: limitMock.mockResolvedValue({ data: [], error: null }),
  };
  Object.assign(selectMock, { mockReturnThis: () => chain });
  fromMock.mockReturnValue(chain);
});

describe('useCustomerCalls', () => {
  it('não roda query quando customerId é null', () => {
    const { result } = renderHook(() => useCustomerCalls(null), { wrapper });
    expect(result.current.isFetching).toBe(false);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('roda query quando customerId existe', async () => {
    limitMock.mockResolvedValueOnce({ data: [{ id: 'call-1' }], error: null });
    const { result } = renderHook(() => useCustomerCalls('cliente-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(fromMock).toHaveBeenCalledWith('farmer_calls');
    expect(eqMock).toHaveBeenCalledWith('customer_user_id', 'cliente-1');
    expect(notMock).toHaveBeenCalledWith('transcript', 'is', null);
    expect(orderMock).toHaveBeenCalledWith('started_at', { ascending: false });
    expect(limitMock).toHaveBeenCalledWith(50);
  });

  it('retorna data vazia quando supabase retorna error', async () => {
    limitMock.mockResolvedValueOnce({ data: null, error: new Error('rls') });
    const { result } = renderHook(() => useCustomerCalls('cliente-1'), { wrapper });
    await waitFor(() => expect(result.current.isError || result.current.data === null).toBe(true));
  });
});
```

- [ ] **Step 2: Falha**

```bash
bun run vitest run src/hooks/__tests__/useCustomerCalls.test.tsx
```

- [ ] **Step 3: Implementação**

```ts
// src/hooks/useCustomerCalls.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Chamada persistida em farmer_calls com contexto rico (transcript não-null).
 * Subset dos campos relevantes pra UI da timeline + expand.
 */
export interface CustomerCallRow {
  id: string;
  farmer_id: string;
  customer_user_id: string | null;
  phone_dialed: string | null;
  call_backend: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  call_result: string;
  call_type: string;
  revenue_generated: number | null;
  margin_generated: number | null;
  notes: string | null;
  // jsonb cols
  transcript: unknown;
  analyses: unknown;
  entities_extracted: unknown;
}

export function useCustomerCalls(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-calls', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CustomerCallRow[]> => {
      if (!customerId) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase
        .from('farmer_calls') as any)
        .select(`
          id, farmer_id, customer_user_id, phone_dialed, call_backend,
          started_at, ended_at, duration_seconds,
          call_result, call_type, revenue_generated, margin_generated, notes,
          transcript, analyses, entities_extracted
        `)
        .eq('customer_user_id', customerId)
        .not('transcript', 'is', null)
        .order('started_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data ?? []) as CustomerCallRow[];
    },
  });
}
```

`as any` é débito temporário até types regenerarem (Lovable já regerou? se sim, remover).

- [ ] **Step 4: Passa**

```bash
bun run vitest run src/hooks/__tests__/useCustomerCalls.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCustomerCalls.ts src/hooks/__tests__/useCustomerCalls.test.tsx
git commit -m "feat(customer-history): useCustomerCalls hook queries farmer_calls with transcript"
```

---

## Task 2: Helper `aggregateCustomerProfile` (TDD)

**Files:**
- Create: `src/lib/call-session/aggregate-customer-profile.ts`
- Create: `src/lib/call-session/aggregate-customer-profile.test.ts`

**Comportamento:** dado `CustomerCallRow[]` (saída do Task 1), retorna `CustomerProfile360` com KPIs e agregações.

- [ ] **Step 1: Testes**

```ts
// src/lib/call-session/aggregate-customer-profile.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateCustomerProfile } from './aggregate-customer-profile';
import type { CustomerCallRow } from '@/hooks/useCustomerCalls';

const call = (overrides: Partial<CustomerCallRow> = {}): CustomerCallRow => ({
  id: `call-${Math.random()}`,
  farmer_id: 'f1',
  customer_user_id: 'c1',
  phone_dialed: '31999991234',
  call_backend: 'webrtc',
  started_at: '2026-05-17T10:00:00Z',
  ended_at: '2026-05-17T10:18:00Z',
  duration_seconds: 1080,
  call_result: 'atendeu',
  call_type: 'venda',
  revenue_generated: 0,
  margin_generated: 0,
  notes: null,
  transcript: [],
  analyses: [],
  entities_extracted: [],
  ...overrides,
});

describe('aggregateCustomerProfile', () => {
  it('array vazio retorna profile zerado', () => {
    const p = aggregateCustomerProfile([]);
    expect(p.totalCalls).toBe(0);
    expect(p.totalDurationSeconds).toBe(0);
    expect(p.totalRevenue).toBe(0);
    expect(p.avgTicket).toBe(0);
    expect(p.competitorsMentioned).toEqual([]);
    expect(p.pricesReferenced).toEqual([]);
    expect(p.topObjections).toEqual([]);
  });

  it('soma duration, revenue, margin', () => {
    const p = aggregateCustomerProfile([
      call({ duration_seconds: 600, revenue_generated: 1000, margin_generated: 300 }),
      call({ duration_seconds: 900, revenue_generated: 2000, margin_generated: 600 }),
    ]);
    expect(p.totalCalls).toBe(2);
    expect(p.totalDurationSeconds).toBe(1500);
    expect(p.totalRevenue).toBe(3000);
    expect(p.totalMargin).toBe(900);
    expect(p.avgTicket).toBe(1500); // 3000/2
  });

  it('avgTicket ignora chamadas com revenue 0 ou null', () => {
    const p = aggregateCustomerProfile([
      call({ revenue_generated: 1000 }),
      call({ revenue_generated: 0 }),
      call({ revenue_generated: null }),
      call({ revenue_generated: 2000 }),
    ]);
    expect(p.avgTicket).toBe(1500); // (1000+2000)/2
  });

  it('agrega competitors únicos das entities das múltiplas chamadas', () => {
    const p = aggregateCustomerProfile([
      call({ entities_extracted: [
        { type: 'competitor', value: 'Farben', context: '', confidence: 0.8, occurrences: 1 },
        { type: 'price', value: 'R$ 35/L', context: '', confidence: 0.7, occurrences: 1 },
      ]}),
      call({ entities_extracted: [
        { type: 'competitor', value: 'farben', context: '', confidence: 0.9, occurrences: 2 },
        { type: 'competitor', value: 'Vernit', context: '', confidence: 0.7, occurrences: 1 },
      ]}),
    ]);
    expect(p.competitorsMentioned).toHaveLength(2);
    expect(p.competitorsMentioned.map(c => c.value).sort()).toEqual(['Farben', 'Vernit']);
    const farben = p.competitorsMentioned.find(c => c.value === 'Farben')!;
    expect(farben.totalOccurrences).toBe(3); // 1+2
  });

  it('extrai top objections de analyses[].risks', () => {
    const p = aggregateCustomerProfile([
      call({ analyses: [
        { risks: [
          { type: 'price_objection', severity: 'high', note: 'achou caro' },
          { type: 'price_objection', severity: 'medium', note: 'comparou com X' },
          { type: 'competitor_mentioned', severity: 'low', note: 'falou Farben' },
        ]},
      ]}),
    ]);
    expect(p.topObjections.length).toBeGreaterThan(0);
    const priceObj = p.topObjections.find(o => o.type === 'price_objection');
    expect(priceObj?.count).toBe(2);
  });

  it('lastCallAt é a data mais recente', () => {
    const p = aggregateCustomerProfile([
      call({ started_at: '2026-05-10T10:00:00Z' }),
      call({ started_at: '2026-05-17T10:00:00Z' }),
      call({ started_at: '2026-05-15T10:00:00Z' }),
    ]);
    expect(p.lastCallAt).toBe('2026-05-17T10:00:00Z');
  });
});
```

- [ ] **Step 2: Falha**, **Step 3: Implementação**:

```ts
// src/lib/call-session/aggregate-customer-profile.ts
import type { CustomerCallRow } from '@/hooks/useCustomerCalls';
import type { AggregatedEntity } from './aggregate-entities';

export interface CompetitorMention {
  value: string;
  totalOccurrences: number;
  maxConfidence: number;
}

export interface ObjectionAgg {
  type: string;
  count: number;
  exampleNote: string;
}

export interface CustomerProfile360 {
  totalCalls: number;
  totalDurationSeconds: number;
  totalRevenue: number;
  totalMargin: number;
  avgTicket: number;
  lastCallAt: string | null;
  competitorsMentioned: CompetitorMention[];
  pricesReferenced: AggregatedEntity[];
  productsCompetitor: AggregatedEntity[];
  topObjections: ObjectionAgg[];
}

interface AnalysisLike {
  risks?: Array<{ type: string; severity: string; note: string }>;
}

/**
 * Agrega múltiplas chamadas de 1 cliente em um perfil 360 v1.
 * Foco em fatos: KPIs + entidades agregadas. Sem inferências/scoring.
 */
export function aggregateCustomerProfile(calls: CustomerCallRow[]): CustomerProfile360 {
  if (calls.length === 0) {
    return {
      totalCalls: 0,
      totalDurationSeconds: 0,
      totalRevenue: 0,
      totalMargin: 0,
      avgTicket: 0,
      lastCallAt: null,
      competitorsMentioned: [],
      pricesReferenced: [],
      productsCompetitor: [],
      topObjections: [],
    };
  }

  const totalDurationSeconds = calls.reduce((s, c) => s + (c.duration_seconds ?? 0), 0);
  const totalRevenue = calls.reduce((s, c) => s + Number(c.revenue_generated ?? 0), 0);
  const totalMargin = calls.reduce((s, c) => s + Number(c.margin_generated ?? 0), 0);
  const revenueCalls = calls.filter((c) => Number(c.revenue_generated ?? 0) > 0);
  const avgTicket = revenueCalls.length === 0
    ? 0
    : revenueCalls.reduce((s, c) => s + Number(c.revenue_generated ?? 0), 0) / revenueCalls.length;

  const lastCallAt = calls
    .map((c) => c.started_at)
    .sort()
    .reverse()[0] ?? null;

  // Agrega entities deduplicadas por (type, value lowercase)
  const allEntities: AggregatedEntity[] = calls.flatMap((c) =>
    Array.isArray(c.entities_extracted) ? (c.entities_extracted as AggregatedEntity[]) : []
  );

  const byTypeValue = new Map<string, AggregatedEntity & { totalOccurrences: number }>();
  for (const e of allEntities) {
    const key = `${e.type}::${e.value.trim().toLowerCase()}`;
    const ex = byTypeValue.get(key);
    if (ex) {
      ex.totalOccurrences += e.occurrences ?? 1;
      if (e.confidence > ex.confidence) ex.confidence = e.confidence;
    } else {
      byTypeValue.set(key, { ...e, totalOccurrences: e.occurrences ?? 1 });
    }
  }

  const allAgg = Array.from(byTypeValue.values());
  const competitorsMentioned: CompetitorMention[] = allAgg
    .filter((e) => e.type === 'competitor')
    .map((e) => ({ value: e.value, totalOccurrences: e.totalOccurrences, maxConfidence: e.confidence }));

  const pricesReferenced = allAgg.filter((e) => e.type === 'price');
  const productsCompetitor = allAgg.filter((e) => e.type === 'product');

  // Top objections: agrega risks[] de todas as análises
  const objMap = new Map<string, ObjectionAgg>();
  for (const c of calls) {
    const analyses = (Array.isArray(c.analyses) ? c.analyses : []) as AnalysisLike[];
    for (const a of analyses) {
      for (const r of (a.risks ?? [])) {
        const ex = objMap.get(r.type);
        if (ex) ex.count += 1;
        else objMap.set(r.type, { type: r.type, count: 1, exampleNote: r.note });
      }
    }
  }
  const topObjections = Array.from(objMap.values()).sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    totalCalls: calls.length,
    totalDurationSeconds,
    totalRevenue,
    totalMargin,
    avgTicket,
    lastCallAt,
    competitorsMentioned,
    pricesReferenced,
    productsCompetitor,
    topObjections,
  };
}
```

- [ ] **Step 4: Tests pass**, **Step 5: Commit**:

```bash
git add src/lib/call-session/aggregate-customer-profile.ts src/lib/call-session/aggregate-customer-profile.test.ts
git commit -m "feat(customer-history): aggregateCustomerProfile builds 360 v1 from farmer_calls"
```

---

## Task 3: Componente `CallSessionDetail` (read-only sheet)

**Files:** Create `src/components/customer/CallSessionDetail.tsx`

Modal/Sheet que mostra:
- Header: data, duração, vendedor, telefone, backend (badge)
- Tabs internas: **Transcript** | **Análises** | **Entidades**
- Transcript: lista de turns com `[VENDEDOR]` / `[CLIENTE]` colorido (estilo do TranscriptionPanel)
- Análises: cada SpinAnalysis com badge de playbook (reusar `STAGE_LABEL`/`PLAYBOOK_LABEL` do `SpinSuggestionCard`) + exactPhrasing + commercialInsight quando playbook=teach
- Entidades: badges agrupados por type

- [ ] **Step 1: Criar componente** (ver código completo nas spec; usa `Sheet` do shadcn)

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { CustomerCallRow } from '@/hooks/useCustomerCalls';
import type { SpinAnalysis } from '@/lib/spin/types';
import type { AggregatedEntity } from '@/lib/call-session/aggregate-entities';

interface CallSessionDetailProps {
  call: CustomerCallRow | null;
  onClose: () => void;
}

interface TranscriptTurnLite {
  speaker: 'vendedor' | 'cliente';
  text: string;
  isFinal: boolean;
  startedAt: number;
}

const ENTITY_TYPE_LABEL: Record<string, string> = {
  competitor: 'Concorrentes',
  price: 'Preços',
  volume: 'Volumes',
  product: 'Produtos do concorrente',
  timeline: 'Prazos',
  decision_maker: 'Decisores',
};

export function CallSessionDetail({ call, onClose }: CallSessionDetailProps) {
  if (!call) return null;

  const transcript = (Array.isArray(call.transcript) ? call.transcript : []) as TranscriptTurnLite[];
  const analyses = (Array.isArray(call.analyses) ? call.analyses : []) as SpinAnalysis[];
  const entities = (Array.isArray(call.entities_extracted) ? call.entities_extracted : []) as AggregatedEntity[];

  const entitiesByType = entities.reduce((acc, e) => {
    if (!acc[e.type]) acc[e.type] = [];
    acc[e.type].push(e);
    return acc;
  }, {} as Record<string, AggregatedEntity[]>);

  const durationMin = Math.floor((call.duration_seconds ?? 0) / 60);
  const durationSec = (call.duration_seconds ?? 0) % 60;

  return (
    <Sheet open={!!call} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2">
            Chamada de {format(new Date(call.started_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
            {call.call_backend && (
              <Badge variant="outline" className="text-2xs uppercase">{call.call_backend}</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {durationMin}min {durationSec}s · {formatDistanceToNow(new Date(call.started_at), { locale: ptBR, addSuffix: true })}
            {call.revenue_generated && Number(call.revenue_generated) > 0 && (
              <> · 💰 R$ {Number(call.revenue_generated).toLocaleString('pt-BR')}</>
            )}
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="transcript" className="mt-4">
          <TabsList className="w-full">
            <TabsTrigger value="transcript" className="flex-1">Transcript ({transcript.length})</TabsTrigger>
            <TabsTrigger value="analyses" className="flex-1">Análises ({analyses.length})</TabsTrigger>
            <TabsTrigger value="entities" className="flex-1">Entidades ({entities.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="transcript" className="space-y-2 mt-4">
            {transcript.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">Sem transcript registrado</div>
            ) : transcript.map((t, idx) => (
              <div key={idx} className={`text-xs ${t.speaker === 'vendedor' ? 'pl-0' : 'pl-8'}`}>
                <span className={`font-medium ${t.speaker === 'vendedor' ? 'text-blue-700' : 'text-emerald-700'}`}>
                  [{t.speaker.toUpperCase()}]
                </span>{' '}
                {t.text}
              </div>
            ))}
          </TabsContent>

          <TabsContent value="analyses" className="space-y-3 mt-4">
            {analyses.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">Sem análises do copilot</div>
            ) : analyses.map((a, idx) => (
              <div key={idx} className="rounded-md border border-border p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-2xs">{a.playbook}</Badge>
                  <Badge variant="outline" className="text-2xs">{a.spinStage}</Badge>
                  <span className="text-2xs text-muted-foreground">{Math.round(a.confidence * 100)}%</span>
                </div>
                <blockquote className="text-xs italic border-l-2 border-status-success pl-2">
                  "{a.nextBestAction.exactPhrasing}"
                </blockquote>
                {a.nextBestAction.commercialInsight && (
                  <div className="text-2xs text-amber-700 dark:text-amber-300">
                    💡 {a.nextBestAction.commercialInsight.dataPoint}
                  </div>
                )}
                {a.ticketLeverage.tactic !== 'none' && (
                  <div className="text-2xs text-orange-700 dark:text-orange-300">
                    💰 {a.ticketLeverage.suggestion}
                  </div>
                )}
              </div>
            ))}
          </TabsContent>

          <TabsContent value="entities" className="space-y-3 mt-4">
            {entities.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">Sem entidades extraídas</div>
            ) : Object.entries(entitiesByType).map(([type, items]) => (
              <div key={type} className="space-y-1">
                <div className="text-2xs uppercase tracking-wide text-muted-foreground">
                  {ENTITY_TYPE_LABEL[type] ?? type}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((e, idx) => (
                    <Badge key={idx} variant="outline" className="text-2xs" title={e.context}>
                      {e.value} {e.occurrences > 1 && <span className="ml-1 opacity-60">×{e.occurrences}</span>}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: tsc + build**
- [ ] **Step 3: Commit**

---

## Task 4: Componente `CallSessionRow` + `CustomerCallsTab`

**Files:**
- Create: `src/components/customer/CallSessionRow.tsx`
- Create: `src/components/customer/CustomerCallsTab.tsx`

CallSessionRow: 1 linha clickable mostrando data relativa, duração, badges (analyses count, entities count), revenue se houver. Click abre CallSessionDetail.

CustomerCallsTab: hook useCustomerCalls + lista de CallSessionRow + state pra qual está aberta.

```tsx
// CallSessionRow
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { MessageSquareText, Lightbulb, Tag } from 'lucide-react';
import type { CustomerCallRow } from '@/hooks/useCustomerCalls';

interface Props {
  call: CustomerCallRow;
  onClick: () => void;
}

export function CallSessionRow({ call, onClick }: Props) {
  const transcriptCount = Array.isArray(call.transcript) ? call.transcript.length : 0;
  const analysesCount = Array.isArray(call.analyses) ? call.analyses.length : 0;
  const entitiesCount = Array.isArray(call.entities_extracted) ? call.entities_extracted.length : 0;
  const durationMin = Math.floor((call.duration_seconds ?? 0) / 60);
  const revenue = Number(call.revenue_generated ?? 0);

  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center justify-between gap-3 rounded-md border border-border p-2.5 hover:bg-muted/40 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">
          {formatDistanceToNow(new Date(call.started_at), { locale: ptBR, addSuffix: true })}
        </div>
        <div className="text-2xs text-muted-foreground">
          {durationMin}min · {call.call_backend ?? 'manual'}{call.call_result && ` · ${call.call_result}`}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {transcriptCount > 0 && <Badge variant="outline" className="gap-1 text-2xs"><MessageSquareText className="w-2.5 h-2.5"/>{transcriptCount}</Badge>}
        {analysesCount > 0 && <Badge variant="outline" className="gap-1 text-2xs"><Lightbulb className="w-2.5 h-2.5"/>{analysesCount}</Badge>}
        {entitiesCount > 0 && <Badge variant="outline" className="gap-1 text-2xs"><Tag className="w-2.5 h-2.5"/>{entitiesCount}</Badge>}
        {revenue > 0 && <Badge variant="outline" className="text-2xs text-status-success border-status-success">R$ {revenue.toLocaleString('pt-BR')}</Badge>}
      </div>
    </button>
  );
}
```

```tsx
// CustomerCallsTab
import { useState } from 'react';
import { useCustomerCalls, type CustomerCallRow } from '@/hooks/useCustomerCalls';
import { CallSessionRow } from './CallSessionRow';
import { CallSessionDetail } from './CallSessionDetail';
import { Loader2 } from 'lucide-react';

export function CustomerCallsTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useCustomerCalls(customerId);
  const [selected, setSelected] = useState<CustomerCallRow | null>(null);

  if (isLoading) {
    return <div className="flex items-center justify-center py-8 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin mr-2"/>Carregando…</div>;
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-xs text-muted-foreground">
        Nenhuma chamada com transcript ainda. As próximas ligações via copilot serão registradas aqui automaticamente.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {data.map((call) => (
          <CallSessionRow key={call.id} call={call} onClick={() => setSelected(call)} />
        ))}
      </div>
      <CallSessionDetail call={selected} onClose={() => setSelected(null)} />
    </>
  );
}
```

- [ ] **Step**: Commit

```bash
git add src/components/customer/CallSessionRow.tsx src/components/customer/CallSessionDetail.tsx src/components/customer/CustomerCallsTab.tsx
git commit -m "feat(customer-history): CustomerCallsTab + CallSessionRow + CallSessionDetail (sheet read-only)"
```

---

## Task 5: Componente `CustomerProfile360Summary`

**Files:** Create `src/components/customer/CustomerProfile360Summary.tsx`

Bloco horizontal no topo do detail view do `AdminCustomers`. 4 KPIs + linha de concorrentes mencionados + linha de top objections.

```tsx
import { useCustomerCalls } from '@/hooks/useCustomerCalls';
import { aggregateCustomerProfile } from '@/lib/call-session/aggregate-customer-profile';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Phone, TrendingUp, Wallet, Clock, AlertTriangle, Building2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function CustomerProfile360Summary({ customerId }: { customerId: string }) {
  const { data } = useCustomerCalls(customerId);
  const profile = aggregateCustomerProfile(data ?? []);

  if (profile.totalCalls === 0) return null;

  return (
    <Card className="p-3 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI icon={Phone} label="Chamadas" value={profile.totalCalls.toString()} sub={profile.lastCallAt ? `Última ${formatDistanceToNow(new Date(profile.lastCallAt), { locale: ptBR, addSuffix: true })}` : ''} />
        <KPI icon={Clock} label="Duração total" value={`${Math.floor(profile.totalDurationSeconds / 60)}min`} />
        <KPI icon={Wallet} label="Receita acumulada" value={`R$ ${profile.totalRevenue.toLocaleString('pt-BR')}`} sub={profile.totalMargin > 0 ? `Margem R$ ${profile.totalMargin.toLocaleString('pt-BR')}` : ''} />
        <KPI icon={TrendingUp} label="Ticket médio" value={profile.avgTicket > 0 ? `R$ ${Math.round(profile.avgTicket).toLocaleString('pt-BR')}` : '—'} />
      </div>

      {profile.competitorsMentioned.length > 0 && (
        <div className="space-y-1">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Building2 className="w-3 h-3"/>Concorrentes citados pelo cliente
          </div>
          <div className="flex flex-wrap gap-1.5">
            {profile.competitorsMentioned.map(c => (
              <Badge key={c.value} variant="outline" className="text-2xs">
                {c.value} <span className="ml-1 opacity-60">×{c.totalOccurrences}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {profile.topObjections.length > 0 && (
        <div className="space-y-1">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="w-3 h-3"/>Objeções recorrentes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {profile.topObjections.map(o => (
              <Badge key={o.type} variant="outline" className="text-2xs" title={o.exampleNote}>
                {o.type.replace(/_/g, ' ')} <span className="ml-1 opacity-60">×{o.count}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function KPI({ icon: Icon, label, value, sub }: { icon: typeof Phone; label: string; value: string; sub?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="w-3 h-3" />{label}
      </div>
      <div className="text-base font-medium tabular-nums">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
```

- [ ] Commit: `feat(customer-history): CustomerProfile360Summary v1 with KPIs + competitors + objections`

---

## Task 6: Integrar tab "Chamadas" no `AdminCustomers.tsx`

**Files:** Modify `src/pages/AdminCustomers.tsx`

- [ ] **Step 1**: import `CustomerCallsTab` + `CustomerProfile360Summary`
- [ ] **Step 2**: na detail view do customer, ANTES do `<Tabs>` existente, render `<CustomerProfile360Summary customerId={customer.user_id} />`
- [ ] **Step 3**: adicionar 1 `<TabsTrigger value="calls" className="gap-1.5"><Phone className="w-3.5 h-3.5"/>Chamadas</TabsTrigger>` (junto com Orders/Tools/Recommendations)
- [ ] **Step 4**: adicionar `<TabsContent value="calls" className="mt-3"><CustomerCallsTab customerId={customer.user_id}/></TabsContent>`
- [ ] **Step 5**: Verificar tsc + build
- [ ] **Step 6**: Commit `feat(customer-history): integrate Chamadas tab + Profile360 in AdminCustomers detail`

---

## Task 7: Hook `useLinkCallToCustomer` (TDD curto)

**Files:**
- Create: `src/hooks/useLinkCallToCustomer.ts`

Mutation simples: `UPDATE farmer_calls SET customer_user_id = $1 WHERE id = $2`. React Query mutation + invalidate query relevante. Test mock supabase.

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function useLinkCallToCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ callId, customerUserId }: { callId: string; customerUserId: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('farmer_calls') as any)
        .update({ customer_user_id: customerUserId })
        .eq('id', callId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-calls'] });
      qc.invalidateQueries({ queryKey: ['farmer-pending-link'] });
      toast.success('Chamada vinculada ao cliente');
    },
    onError: (err) => {
      toast.error('Erro ao vincular', { description: err instanceof Error ? err.message : '' });
    },
  });
}
```

- [ ] Commit: `feat(customer-history): useLinkCallToCustomer mutation`

---

## Task 8: Página `FarmerCallsPendingLink`

**Files:**
- Create: `src/pages/FarmerCallsPendingLink.tsx`
- Modify: `src/App.tsx` — rota + lazy import
- Modify: `src/components/AppShell.tsx` — item de menu na seção Farmer

Página simples:
- Lista chamadas onde `customer_user_id IS NULL AND farmer_id = currentUser.id` (RLS já cuida)
- Cada item: data, phone_dialed, duração, badges de transcript/analyses
- Botão "Vincular cliente" abre Combobox de busca em `profiles` (filtra por role customer)
- Confirma → `useLinkCallToCustomer.mutate({ callId, customerUserId })` → linha some

```tsx
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLinkCallToCustomer } from '@/hooks/useLinkCallToCustomer';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface Pending {
  id: string;
  phone_dialed: string | null;
  started_at: string;
  duration_seconds: number | null;
}

export default function FarmerCallsPendingLink() {
  const { user } = useAuth();
  const { data, refetch } = useQuery({
    queryKey: ['farmer-pending-link', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<Pending[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('farmer_calls') as any)
        .select('id, phone_dialed, started_at, duration_seconds')
        .eq('farmer_id', user!.id)
        .is('customer_user_id', null)
        .not('transcript', 'is', null)
        .order('started_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Pending[];
    },
  });

  return (
    <div className="container mx-auto p-4 space-y-3">
      <h1 className="text-xl font-semibold">Chamadas pendentes de vínculo</h1>
      <p className="text-xs text-muted-foreground">Chamadas com transcript salvo mas sem cliente vinculado. Vincule pra elas aparecerem no histórico do cliente.</p>

      {!data || data.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          Nenhuma chamada pendente — todas estão vinculadas a clientes.
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((p) => (
            <PendingRow key={p.id} pending={p} onLinked={refetch} />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingRow({ pending, onLinked }: { pending: Pending; onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const link = useLinkCallToCustomer();

  const { data: profiles } = useQuery({
    queryKey: ['profiles-search', search],
    enabled: open && search.length >= 2,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('profiles') as any)
        .select('user_id, full_name, phone')
        .or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`)
        .limit(10);
      return data ?? [];
    },
  });

  return (
    <Card className="p-3 flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">{pending.phone_dialed ?? 'Sem telefone'}</div>
        <div className="text-2xs text-muted-foreground">
          {formatDistanceToNow(new Date(pending.started_at), { locale: ptBR, addSuffix: true })}
          {pending.duration_seconds && ` · ${Math.floor(pending.duration_seconds / 60)}min`}
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">Vincular cliente</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>Vincular a um cliente</DialogTitle></DialogHeader>
          <Command>
            <CommandInput placeholder="Busque por nome ou telefone…" value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>{search.length < 2 ? 'Digite ao menos 2 caracteres' : 'Nenhum cliente encontrado'}</CommandEmpty>
              {(profiles ?? []).map((p: { user_id: string; full_name: string; phone: string }) => (
                <CommandItem
                  key={p.user_id}
                  onSelect={() => {
                    link.mutate({ callId: pending.id, customerUserId: p.user_id }, {
                      onSuccess: () => { setOpen(false); onLinked(); },
                    });
                  }}
                >
                  <div>
                    <div className="text-sm">{p.full_name}</div>
                    <div className="text-2xs text-muted-foreground">{p.phone}</div>
                  </div>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
```

App.tsx (lazy + rota):
```tsx
const FarmerCallsPendingLink = lazy(() => import("./pages/FarmerCallsPendingLink"));
// dentro do <Routes>:
<Route path="farmer/calls/pending-link" element={<FarmerCallsPendingLink />} />
```

AppShell: item no menu Farmer (similar aos outros).

- [ ] Commit: `feat(customer-history): FarmerCallsPendingLink page + route + menu`

---

## Task 9: QA + PR

- [ ] Suite: `bun run vitest run` (espera 223 → ~232: 3 useCustomerCalls + 6 aggregate-customer-profile)
- [ ] tsc clean
- [ ] build passa
- [ ] Push + PR

---

## Self-Review

**1. Spec coverage:**

| Spec | Task |
|---|---|
| Timeline de chamadas por cliente | Tasks 1, 4 |
| Expand transcript + analyses + entities | Task 3 |
| Perfil 360 v1 (KPIs + concorrentes + objeções) | Tasks 2, 5 |
| Tab "Chamadas" em /admin/customers/:id | Task 6 |
| Página de chamadas pendentes de vínculo | Tasks 7, 8 |
| Vincular cliente posterior | Tasks 7, 8 |

**2. Placeholder scan:** Sem TBD.

**3. Type consistency:** `CustomerCallRow` exported em Task 1 → consumido em Tasks 2, 3, 4, 5. `CustomerProfile360` em Task 2 → consumido em Task 5. `AggregatedEntity` reusado de PR4. `SpinAnalysis` reusado de PR3.5.

**4. Riscos:**
- **`as any` em todos os `from('farmer_calls')`**: idem PR4 — débito até Lovable regenerar types. Plan documenta.
- **Performance**: limit 50 chamadas por customer + LIMIT 50 por farmer pending. Cliente com 200+ chamadas vai mostrar 50; suficiente pra UX. Refactor pra paginate vira PR posterior.
- **AppShell menu Farmer**: assumo que existe seção "Farmer". Se não, criar inline ou colocar em "Vendas".

---

## Execution Handoff

Plan salvo em `docs/superpowers/plans/2026-05-17-pr5-customer-call-history.md`.

Execução: **Subagent-Driven**. Tasks 1+2+3 podem rodar em paralelo (independentes). Tasks 4, 5, 6, 7, 8 sequenciais ou pareadas conforme dependências.
