# Ficha de 30s pré-contato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um drawer "ficha de 30s" que abre ao tocar num cliente da lista de ligação, mostrando munição (já existe) + histórico de compras com preço praticado.

**Architecture:** Lógica pura testável (`historico.ts`) ← hook read-only lazy (`useHistoricoCompras`, 3 queries sem N+1) → componente drawer (`FichaPreContato`, Sheet shadcn) plugado na `RotaListaLigacao`. Extrai `MunicaoResumo` hoje duplicado no `CallCopilotHud`.

**Tech Stack:** React 18 + TS strict, @tanstack/react-query, shadcn/ui (Sheet), Supabase JS, vitest.

**Spec:** `docs/superpowers/specs/2026-06-29-ficha-pre-contato-design.md`

---

## File Structure

- Create `src/lib/call/historico.ts` — tipos + `derivarHistorico` (puro).
- Create `src/lib/call/historico.test.ts` — testes da derivação.
- Create `src/hooks/useHistoricoCompras.ts` — busca read-only (3 queries) + deriva.
- Create `src/components/call/MunicaoResumo.tsx` — exibição da munição (extraída do HUD).
- Modify `src/components/call/CallCopilotHud.tsx` — usar `MunicaoResumo` (remove duplicação + `brl` órfão).
- Create `src/components/call/FichaPreContato.tsx` — drawer (Sheet) que junta munição + histórico.
- Modify `src/pages/RotaListaLigacao.tsx` — nome do cliente vira trigger do drawer.

Junção confirmada: `order_items.omie_codigo_produto` (bigint) = `omie_products.omie_codigo_produto` (bigint), único → nome por código só. Sem FK `order_items`→`sales_orders` → 3 queries separadas.

---

### Task 1: Lógica pura `historico.ts` (TDD)

**Files:**
- Create: `src/lib/call/historico.ts`
- Test: `src/lib/call/historico.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/call/historico.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { derivarHistorico } from './historico';

const agora = new Date('2026-06-29T12:00:00Z');

describe('derivarHistorico', () => {
  it('agrupa itens por produto, conta vezes e pega o último preço/data', () => {
    const h = derivarHistorico({
      agora,
      pedidos: [],
      itens: [
        { codigo: 1, nome: 'Verniz', quantidade: 2, precoUnit: 40, dataPedido: '2026-05-01' },
        { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: 45, dataPedido: '2026-06-10' },
        { codigo: 2, nome: 'Seladora', quantidade: 1, precoUnit: 30, dataPedido: '2026-04-01' },
      ],
    });
    expect(h.topProdutos[0]).toEqual({ codigo: 1, nome: 'Verniz', vezes: 2, ultimoPreco: 45, ultimaData: '2026-06-10' });
    expect(h.topProdutos[1]).toEqual({ codigo: 2, nome: 'Seladora', vezes: 1, ultimoPreco: 30, ultimaData: '2026-04-01' });
  });

  it('ordena por vezes desc, desempata por recência', () => {
    const h = derivarHistorico({
      agora, pedidos: [],
      itens: [
        { codigo: 1, nome: 'A', quantidade: 1, precoUnit: 1, dataPedido: '2026-01-01' },
        { codigo: 2, nome: 'B', quantidade: 1, precoUnit: 1, dataPedido: '2026-06-01' },
        { codigo: 2, nome: 'B', quantidade: 1, precoUnit: 1, dataPedido: '2026-06-02' },
        { codigo: 3, nome: 'C', quantidade: 1, precoUnit: 1, dataPedido: '2026-05-01' },
      ],
    });
    // B (2 vezes) primeiro; depois C e A empatados em 1 → C mais recente que A
    expect(h.topProdutos.map((p) => p.nome)).toEqual(['B', 'C', 'A']);
  });

  it('limita topProdutos a 5', () => {
    const itens = Array.from({ length: 8 }, (_, i) => ({
      codigo: i, nome: `P${i}`, quantidade: 1, precoUnit: 1, dataPedido: '2026-06-01',
    }));
    expect(derivarHistorico({ agora, pedidos: [], itens }).topProdutos).toHaveLength(5);
  });

  it('ultimosPedidos = 3 mais recentes por data', () => {
    const h = derivarHistorico({
      agora, itens: [],
      pedidos: [
        { data: '2026-06-10', valor: 100, nItens: 2 },
        { data: '2026-06-20', valor: 200, nItens: 3 },
        { data: '2026-05-01', valor: 50, nItens: 1 },
        { data: '2026-04-01', valor: 30, nItens: 1 },
      ],
    });
    expect(h.ultimosPedidos.map((p) => p.data)).toEqual(['2026-06-20', '2026-06-10', '2026-05-01']);
  });

  it('exclui datas futuras (Omie adianta order_date_kpi)', () => {
    const h = derivarHistorico({
      agora, pedidos: [{ data: '2027-01-01', valor: 999, nItens: 9 }],
      itens: [{ codigo: 1, nome: 'Futuro', quantidade: 1, precoUnit: 1, dataPedido: '2027-01-01' }],
    });
    expect(h.topProdutos).toEqual([]);
    expect(h.ultimosPedidos).toEqual([]);
  });

  it('vazio → listas vazias (sem fabricar)', () => {
    expect(derivarHistorico({ agora, itens: [], pedidos: [] })).toEqual({ topProdutos: [], ultimosPedidos: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bunx vitest run src/lib/call/historico.test.ts`
Expected: FAIL — "Failed to resolve import './historico'" / `derivarHistorico is not a function`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/call/historico.ts`:

```ts
export interface HistoricoItemInput {
  codigo: number;
  nome: string;
  quantidade: number;
  precoUnit: number;
  dataPedido: string; // ISO — data de negócio do pedido (order_date_kpi)
}
export interface HistoricoPedidoInput {
  data: string; // ISO
  valor: number;
  nItens: number;
}
export interface HistoricoInput {
  itens: HistoricoItemInput[];
  pedidos: HistoricoPedidoInput[];
  agora: Date;
}
export interface TopProduto {
  codigo: number;
  nome: string;
  vezes: number;
  ultimoPreco: number;
  ultimaData: string;
}
export interface PedidoResumo {
  data: string;
  valor: number;
  nItens: number;
}
export interface Historico {
  topProdutos: TopProduto[];
  ultimosPedidos: PedidoResumo[];
}

const naoFutura = (iso: string, hojeMs: number): boolean => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t <= hojeMs;
};

/**
 * Derivação pura da ficha pré-contato. Recebe itens JÁ filtrados por pedido
 * válido (o hook exclui status inválidos). Ignora datas futuras (Omie adianta
 * order_date_kpi). Sem dados → listas vazias (nunca fabrica).
 */
export function derivarHistorico({ itens, pedidos, agora }: HistoricoInput): Historico {
  const hojeMs = agora.getTime();

  const porProduto = new Map<number, TopProduto>();
  for (const it of itens) {
    if (!naoFutura(it.dataPedido, hojeMs)) continue;
    const atual = porProduto.get(it.codigo);
    if (!atual) {
      porProduto.set(it.codigo, {
        codigo: it.codigo, nome: it.nome, vezes: 1,
        ultimoPreco: it.precoUnit, ultimaData: it.dataPedido,
      });
    } else {
      atual.vezes += 1;
      if (new Date(it.dataPedido).getTime() > new Date(atual.ultimaData).getTime()) {
        atual.ultimaData = it.dataPedido;
        atual.ultimoPreco = it.precoUnit;
        atual.nome = it.nome;
      }
    }
  }

  const topProdutos = [...porProduto.values()]
    .sort((a, b) =>
      b.vezes - a.vezes ||
      new Date(b.ultimaData).getTime() - new Date(a.ultimaData).getTime(),
    )
    .slice(0, 5);

  const ultimosPedidos = pedidos
    .filter((p) => naoFutura(p.data, hojeMs))
    .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime())
    .slice(0, 3);

  return { topProdutos, ultimosPedidos };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bunx vitest run src/lib/call/historico.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/call/historico.ts src/lib/call/historico.test.ts
git commit -m "feat(ficha): derivarHistorico puro (top produtos + últimos pedidos) — TDD"
```

---

### Task 2: Hook `useHistoricoCompras` (read-only, lazy, 3 queries)

**Files:**
- Create: `src/hooks/useHistoricoCompras.ts`

- [ ] **Step 1: Write the implementation**

Create `src/hooks/useHistoricoCompras.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { derivarHistorico, type Historico, type HistoricoItemInput, type HistoricoPedidoInput } from '@/lib/call/historico';

/** Status que NÃO representam venda concluída (espelha useMunicaoLigacao). */
const STATUS_INVALIDOS = new Set(['rascunho', 'orcamento', 'cancelado', 'cancelado_humano']);
const MAX_PEDIDOS = 50;

interface PedidoRow { id: string; order_date_kpi: string | null; created_at: string; total: number | null; status: string | null; }
interface ItemRow { sales_order_id: string; omie_codigo_produto: number | null; quantity: number | null; unit_price: number | null; }
interface ProdutoRow { omie_codigo_produto: number; descricao: string | null; }

/**
 * Ficha pré-contato READ-ONLY: histórico de compras + preço praticado.
 * Lazy (só dispara com customerUserId). 3 queries fixas, sem N+1.
 * MANDATO: nunca escreve / nunca cria cadastro.
 */
export function useHistoricoCompras(customerUserId: string | null): { historico: Historico | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['historico-compras', customerUserId],
    enabled: !!customerUserId,
    staleTime: 60_000,
    queryFn: async (): Promise<Historico> => {
      // 1) pedidos válidos do cliente (status inválido filtrado no client — padrão do projeto)
      const { data: pedidosRaw, error: e1 } = await supabase
        .from('sales_orders')
        .select('id, order_date_kpi, created_at, total, status')
        .eq('customer_user_id', customerUserId!)
        .is('deleted_at', null)
        .order('order_date_kpi', { ascending: false, nullsFirst: false })
        .limit(MAX_PEDIDOS);
      if (e1) throw e1;
      const pedidos = ((pedidosRaw ?? []) as PedidoRow[]).filter((p) => !STATUS_INVALIDOS.has(p.status ?? ''));
      if (pedidos.length === 0) return { topProdutos: [], ultimosPedidos: [] };

      const dataDoPedido = new Map(pedidos.map((p) => [p.id, p.order_date_kpi ?? p.created_at]));
      const ids = pedidos.map((p) => p.id);

      // 2) itens desses pedidos (.limit guard contra o cap silencioso de 1000 do PostgREST)
      const { data: itensRaw, error: e2 } = await supabase
        .from('order_items')
        .select('sales_order_id, omie_codigo_produto, quantity, unit_price')
        .in('sales_order_id', ids)
        .limit(1000);
      if (e2) throw e2;
      const itensRows = ((itensRaw ?? []) as ItemRow[]).filter((r) => r.omie_codigo_produto != null);

      // 3) nomes dos produtos (omie_codigo_produto é único em omie_products → por código só)
      const codigos = [...new Set(itensRows.map((r) => r.omie_codigo_produto as number))];
      const nomePorCodigo = new Map<number, string>();
      if (codigos.length > 0) {
        const { data: prodRaw, error: e3 } = await supabase
          .from('omie_products')
          .select('omie_codigo_produto, descricao')
          .in('omie_codigo_produto', codigos);
        if (e3) throw e3;
        for (const p of (prodRaw ?? []) as ProdutoRow[]) {
          if (p.descricao) nomePorCodigo.set(p.omie_codigo_produto, p.descricao);
        }
      }

      const itens: HistoricoItemInput[] = itensRows.map((r) => ({
        codigo: r.omie_codigo_produto as number,
        nome: nomePorCodigo.get(r.omie_codigo_produto as number) ?? `Cód. ${r.omie_codigo_produto}`,
        quantidade: Number(r.quantity ?? 0),
        precoUnit: Number(r.unit_price ?? 0),
        dataPedido: dataDoPedido.get(r.sales_order_id) ?? '',
      }));

      const nItensPorPedido = new Map<string, number>();
      for (const r of itensRows) nItensPorPedido.set(r.sales_order_id, (nItensPorPedido.get(r.sales_order_id) ?? 0) + 1);

      const pedidosInput: HistoricoPedidoInput[] = pedidos.map((p) => ({
        data: p.order_date_kpi ?? p.created_at,
        valor: Number(p.total ?? 0),
        nItens: nItensPorPedido.get(p.id) ?? 0,
      }));

      return derivarHistorico({ itens, pedidos: pedidosInput, agora: new Date() });
    },
  });

  return { historico: data ?? null, loading: isLoading };
}
```

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS. If `supabase.from('sales_orders'|'order_items'|'omie_products')` errors on generated types, cast the row arrays as already done (`as PedidoRow[]` etc.); if `.from` itself rejects the table name, follow the `routeFrom` cast pattern from `src/queries/useRouteContactList.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useHistoricoCompras.ts
git commit -m "feat(ficha): useHistoricoCompras (read-only, lazy, 3 queries sem N+1)"
```

---

### Task 3: Extrair `MunicaoResumo` e usar no `CallCopilotHud`

**Files:**
- Create: `src/components/call/MunicaoResumo.tsx`
- Modify: `src/components/call/CallCopilotHud.tsx`

- [ ] **Step 1: Create the shared component**

Create `src/components/call/MunicaoResumo.tsx`:

```tsx
import type { Municao } from '@/lib/call/municao';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Resumo da munição (última compra + ticket médio). Conteúdo puro — o container aplica padding. */
export function MunicaoResumo({ municao }: { municao: Municao | null }) {
  if (!municao) return null;
  return (
    <div className="text-xs text-muted-foreground space-y-0.5">
      {municao.ultimaCompra ? (
        <div>
          Última compra:{' '}
          <span className="text-foreground font-medium">{brl(municao.ultimaCompra.valor)}</span>
          {municao.diasDesdeUltima != null && <> · há {municao.diasDesdeUltima}d</>}
        </div>
      ) : (
        <div>Sem compras anteriores registradas.</div>
      )}
      {municao.ticketMedio != null && <div>Ticket médio: {brl(municao.ticketMedio)}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Use it in CallCopilotHud**

In `src/components/call/CallCopilotHud.tsx`:

1. Add import after the `useMunicaoLigacao` import:
```tsx
import { MunicaoResumo } from './MunicaoResumo';
```

2. Delete the local `brl` const (lines ~12-13) — now lives in `MunicaoResumo`.

3. Replace the whole munição block (the `{municao && ( ... )}` JSX, ~lines 86-105) with:
```tsx
        {municao && (
          <div className="px-3 py-2 border-b border-border">
            <MunicaoResumo municao={municao} />
          </div>
        )}
```

- [ ] **Step 3: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: PASS, no "brl is declared but never used".

- [ ] **Step 4: Commit**

```bash
git add src/components/call/MunicaoResumo.tsx src/components/call/CallCopilotHud.tsx
git commit -m "refactor(call): extrai MunicaoResumo (reuso ficha + HUD)"
```

---

### Task 4: Componente `FichaPreContato` (drawer)

**Files:**
- Create: `src/components/call/FichaPreContato.tsx`

- [ ] **Step 1: Implement the drawer**

Create `src/components/call/FichaPreContato.tsx`:

```tsx
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useMunicaoLigacao } from '@/hooks/useMunicaoLigacao';
import { useHistoricoCompras } from '@/hooks/useHistoricoCompras';
import { MunicaoResumo } from './MunicaoResumo';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

interface Props {
  customerUserId: string;
  name: string;
  cidade: string;
  children: React.ReactNode; // trigger
}

export function FichaPreContato({ customerUserId, name, cidade, children }: Props) {
  const [open, setOpen] = useState(false);
  // Lazy: só busca quando o drawer abre.
  const alvo = open ? customerUserId : null;
  const { municao } = useMunicaoLigacao(alvo);
  const { historico, loading } = useHistoricoCompras(alvo);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right" className="w-[90vw] sm:max-w-md overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="truncate">{name}</SheetTitle>
          <p className="text-xs text-muted-foreground">{cidade}</p>
        </SheetHeader>

        <div className="mt-3 rounded-md bg-muted/40 px-3 py-2">
          <MunicaoResumo municao={municao} />
        </div>

        {loading ? (
          <div className="mt-4 space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : historico && (historico.topProdutos.length > 0 || historico.ultimosPedidos.length > 0) ? (
          <>
            {historico.topProdutos.length > 0 && (
              <section className="mt-4">
                <h3 className="text-2xs uppercase tracking-wide text-muted-foreground mb-1">Compra com frequência</h3>
                <ul className="space-y-1">
                  {historico.topProdutos.map((p) => (
                    <li key={p.codigo} className="flex items-center justify-between gap-2 text-sm border-b last:border-0 py-1">
                      <span className="truncate">{p.nome}</span>
                      <span className="font-tabular text-xs text-muted-foreground shrink-0">
                        {p.vezes}× · {brl(p.ultimoPreco)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {historico.ultimosPedidos.length > 0 && (
              <section className="mt-4">
                <h3 className="text-2xs uppercase tracking-wide text-muted-foreground mb-1">Últimos pedidos</h3>
                <ul className="space-y-1">
                  {historico.ultimosPedidos.map((p, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 text-sm font-tabular py-0.5">
                      <span>{dataBr(p.data)}</span>
                      <span>{brl(p.valor)} <span className="text-muted-foreground">({p.nItens} itens)</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Sem compras registradas para este cliente.</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: PASS. If `SheetTrigger`/`SheetContent`/`SheetHeader`/`SheetTitle` are not exported from `@/components/ui/sheet`, open that file and import the names it actually exports.

- [ ] **Step 3: Commit**

```bash
git add src/components/call/FichaPreContato.tsx
git commit -m "feat(ficha): FichaPreContato (drawer munição + histórico, lazy)"
```

---

### Task 5: Plugar na `RotaListaLigacao`

**Files:**
- Modify: `src/pages/RotaListaLigacao.tsx`

- [ ] **Step 1: Import the drawer**

After the `OutcomeMenu` import (~line 13):
```tsx
import { FichaPreContato } from '@/components/call/FichaPreContato';
```

- [ ] **Step 2: Wrap the customer text block as the drawer trigger**

In the list `<li>` (~lines 147-156), replace the text `<div className="flex-1 min-w-0">…</div>` block with a `FichaPreContato` wrapping a `<button>` trigger:

```tsx
                <FichaPreContato customerUserId={c.customerUserId} name={c.name} cidade={c.cityKey.city}>
                  <button type="button" className="flex-1 min-w-0 text-left">
                    <div className="text-sm truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground font-tabular flex items-center gap-2 flex-wrap">
                      <span>{c.cityKey.city}</span>
                      {c.ultimoContatoRealHaDias != null && <span>· contatado há {c.ultimoContatoRealHaDias}d</span>}
                      {c.semRespostaRecenteN > 0 && <span>· sem resposta {c.semRespostaRecenteN}×</span>}
                    </div>
                  </button>
                </FichaPreContato>
```

The `<span className="font-mono ...">{i + 1}</span>` (left), the `Badge`, the `valorDaLigacao` span, the `CallButton` and `OutcomeMenu` (right) stay as siblings, unchanged — only the middle text block becomes the trigger.

- [ ] **Step 3: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/RotaListaLigacao.tsx
git commit -m "feat(ficha): abre a ficha pré-contato ao tocar no cliente da fila"
```

---

### Task 6: Validação final

- [ ] **Step 1: Full suite + build**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo TC=$?` then `heavy bunx vitest run src/lib/call > /tmp/t.log 2>&1; echo T=$?` then `bun lint > /tmp/l.log 2>&1; echo L=$?` then `heavy bun run build > /tmp/b.log 2>&1; echo B=$?`
Expected: TC=0, T=0, L=0, B=0. Read any non-zero log.

- [ ] **Step 2: Open PR**

```bash
git push -u origin worktree-ficha-pre-contato
gh pr create --base main --title "feat(ficha): ficha de 30s pré-contato na fila de ligação (Frente 3)" --body "Drawer pré-discagem (munição + histórico de compras/preço praticado) ao tocar no cliente da lista de ligação. Lógica pura testada; read-only; lazy. Cores cortado por falta de fonte (ver spec). Frontend-only → **Publish no Lovable após merge**."
```

- [ ] **Step 3: Lembrar o founder do Publish no Lovable** (frontend-only; sem migration/edge).

---

## Self-Review

- **Spec coverage:** munição reusada (Task 3/4) ✓; histórico+preço (Task 1/2) ✓; drawer na lista (Task 4/5) ✓; read-only/lazy/sem-N+1 (Task 2) ✓; degradação honesta (empty states, Task 4) ✓; cores/títulos/conversa fora ✓. Sem gaps.
- **Placeholders:** nenhum — todo step tem código/comando real.
- **Type consistency:** `derivarHistorico`/`Historico`/`HistoricoItemInput`/`HistoricoPedidoInput`/`TopProduto`/`PedidoResumo` idênticos entre Task 1 (def), Task 2 (uso) e Task 4 (render). `Municao` reusado de `municao.ts`. `MunicaoResumo` mesma assinatura em Task 3 e 4.
