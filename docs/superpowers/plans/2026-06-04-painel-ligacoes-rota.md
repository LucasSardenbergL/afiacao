# Painel das Ligações da Rota — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Painel de decisão (`/rota/ligacoes/painel`, master/gestor) que mede **cobertura × eficácia** do programa de ligações da rota — pra responder "automatizar mais (WhatsApp) vs contratar". Headline = **valor esperado ficando sem contato (gap)** + retorno reportado.

**Architecture:** A fila de elegíveis NÃO é persistida hoje (só os contatos, em `route_contact_log`). Então persistimos a fila **on-open** (a vendedora abre `/rota/ligacoes` → grava o que viu, idempotente) numa tabela nova `route_queue_snapshot` (o **denominador**). O painel (client-side, helpers puros TDD) junta snapshot (elegíveis) × `route_contact_log` (contatos) e agrega. Valor = **score esperado** das convertidas (NÃO R$); conversão = **reportada**; taxas com **gating n≥30**; opt-out = guardrail.

**Tech Stack:** React 18 + TS strict + Vite + Supabase (1 migration manual via Lovable) + vitest (TDD) + sonner + shadcn/ui. Fuso `spBusinessDate`.

**Spec:** `docs/superpowers/specs/2026-06-04-painel-ligacoes-rota-design.md`

> ⚠️ **Migration manual** (Task 1): a tabela `route_queue_snapshot` precisa ser colada no SQL Editor do Lovable (entrego o bloco). Sem ela, o snapshot-on-open falha silencioso (best-effort) e o painel mostra "denominador indisponível".
> ⚠️ Sem edge function nova. Sem deploy de edge.

---

## File Structure

**Migration:** `supabase/migrations/20260604120000_route_queue_snapshot.sql`

**Helpers puros (TDD, `src/lib/route/painel/`):**
- `types.ts` — `SnapshotRow`, `ContatoRow`, `PainelAgregado`, `TaxaGated`.
- `gating.ts` (+test) — `taxaComGating`.
- `agregar.ts` (+test) — `agregarPainel` (cobertura, gap, capacidade, eficácia, cortes, dias-sem-denominador).

**Frontend:**
- `src/queries/useSnapshotRouteQueue.ts` — write best-effort do snapshot on-open.
- `src/queries/useRoutePanel.ts` — lê snapshot + log (paginado) → `agregarPainel`.
- `src/pages/RotaPainelLigacoes.tsx` — a página (gate master/gestor).
- Editar: `src/pages/RotaListaLigacao.tsx` (dispara o snapshot + link pro painel), `src/App.tsx` (rota nova).

---

## Task 1: Migration `route_queue_snapshot` (apply manual)

**Files:** Create `supabase/migrations/20260604120000_route_queue_snapshot.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Painel das ligações da rota: persiste a FILA de elegíveis (denominador) que a
-- vendedora viu ao abrir /rota/ligacoes. Idempotente por (data_rota, farmer_id, customer).
CREATE TABLE IF NOT EXISTS public.route_queue_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_rota date NOT NULL,
  farmer_id uuid NOT NULL,                 -- o VISUALIZADOR (quem viu a lista)
  customer_user_id uuid NOT NULL,
  cidade text,
  bucket text,                             -- top/winback/coldstart (do ScoredCandidate)
  valor_da_ligacao numeric,                -- valor ESPERADO (score), não R$
  rank int,                                -- posição na fila no momento da abertura
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_rota, farmer_id, customer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_rqs_data ON public.route_queue_snapshot(data_rota);
CREATE INDEX IF NOT EXISTS idx_rqs_farmer_data ON public.route_queue_snapshot(farmer_id, data_rota);

ALTER TABLE public.route_queue_snapshot ENABLE ROW LEVEL SECURITY;

-- leitura: staff (employee/master) — mesmo critério do route_contact_log.
CREATE POLICY "rqs_staff_read" ON public.route_queue_snapshot FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur
                 WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
-- escrita: o próprio farmer grava a fila que ELE viu (farmer_id = auth.uid()), ou master.
CREATE POLICY "rqs_self_write" ON public.route_queue_snapshot FOR INSERT TO authenticated
  WITH CHECK (farmer_id = (select auth.uid())
              OR EXISTS (SELECT 1 FROM public.user_roles ur
                         WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));
```

- [ ] **Step 2: Validação (também pra colar no SQL Editor)**

```sql
SELECT 'route_queue_snapshot OK' AS status,
       (SELECT count(*) FROM information_schema.tables WHERE table_name='route_queue_snapshot') AS tabela,
       (SELECT count(*) FROM pg_indexes WHERE tablename='route_queue_snapshot') AS indices,
       (SELECT count(*) FROM pg_policies WHERE tablename='route_queue_snapshot') AS policies;
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260604120000_route_queue_snapshot.sql
git commit -m "feat(rota-painel): migration route_queue_snapshot (denominador da fila)"
```

> **Apply:** entregar o bloco do Step 1 + a validação do Step 2 pro founder colar no SQL Editor do Lovable (pós-merge). Esperado: `tabela=1, indices≥3, policies=2`.

---

## Task 2: Tipos do painel

**Files:** Create `src/lib/route/painel/types.ts`

- [ ] **Step 1: Escrever os tipos**

```ts
// src/lib/route/painel/types.ts

/** Linha de route_queue_snapshot (snake_case, como vem do banco). */
export interface SnapshotRow {
  data_rota: string;
  farmer_id: string;
  customer_user_id: string;
  cidade: string | null;
  bucket: string | null;
  valor_da_ligacao: number | null;
  rank: number | null;
}

/** Linha de route_contact_log relevante ao painel. */
export interface ContatoRow {
  data_rota: string;
  farmer_id: string | null;
  customer_user_id: string | null;
  canal: string;                 // 'ligacao' | 'whatsapp'
  status: string | null;         // enviado/respondido/convertido/sem_resposta/opt_out
  valor_da_ligacao: number | null;
  bucket: string | null;
}

/** Taxa com freio de baixo volume (codex P3.7). */
export interface TaxaGated {
  valor: number | null;          // fração 0..1, null se não exibível
  exibivel: boolean;             // n >= min
  fracao: string;                // "3/12"
  n: number;                     // denominador
}

export interface GrupoEficacia {
  chave: string;                 // farmer_id / bucket / canal
  contatos: number;
  resposta: TaxaGated;
  conversao: TaxaGated;
  optout: TaxaGated;
  valor_capturado: number;       // Σ valor das convertidas (score esperado, NÃO R$)
}

export interface PainelAgregado {
  // cobertura (ligação): elegíveis = snapshot; contatados = elegíveis com contato
  elegiveis_n: number;
  contatados_n: number;
  cobertura_count: TaxaGated;
  elegiveis_valor: number;
  contatados_valor: number;
  gap_valor: number;             // Σ valor dos elegíveis NÃO contatados (headline)
  // capacidade
  contatos_total: number;
  dias_com_dado: number;
  contatos_por_dia: number;      // contatos_total / dias_com_dado (0 se sem dado)
  dias_sem_denominador: number;  // dias com contato de ligação mas sem snapshot
  // eficácia global (sobre contatos de ligação)
  global: GrupoEficacia;
  // cortes
  por_vendedora: GrupoEficacia[];
  por_bucket: GrupoEficacia[];
  por_canal: GrupoEficacia[];    // aqui contatos de TODOS os canais
}
```

- [ ] **Step 2: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/route/painel/types.ts
git commit -m "feat(rota-painel): tipos do painel de ligações"
```

---

## Task 3: Helper `taxaComGating` (TDD)

**Files:** Create `src/lib/route/painel/gating.ts` + `__tests__/gating.test.ts`

- [ ] **Step 1: Teste (falha)**

```ts
// src/lib/route/painel/__tests__/gating.test.ts
import { describe, it, expect } from 'vitest';
import { taxaComGating } from '../gating';

describe('taxaComGating', () => {
  it('n >= min → exibível, fração e valor', () => {
    const t = taxaComGating(15, 30);
    expect(t).toEqual({ valor: 0.5, exibivel: true, fracao: '15/30', n: 30 });
  });
  it('n < min → não exibível (mostra fração, valor null)', () => {
    const t = taxaComGating(3, 12);
    expect(t).toMatchObject({ valor: null, exibivel: false, fracao: '3/12', n: 12 });
  });
  it('denominador 0 → fração 0/0, não exibível, valor null', () => {
    expect(taxaComGating(0, 0)).toMatchObject({ valor: null, exibivel: false, fracao: '0/0', n: 0 });
  });
  it('min custom', () => {
    expect(taxaComGating(5, 10, 5).exibivel).toBe(true);  // n=10 >= 5
  });
});
```

- [ ] **Step 2: Rodar (falha)**

Run: `heavy bun run test src/lib/route/painel/__tests__/gating.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/route/painel/gating.ts
import type { TaxaGated } from './types';

/** Taxa num/den com freio de baixo volume. Abaixo de `min`, valor=null (só fração). */
export function taxaComGating(num: number, den: number, min = 30): TaxaGated {
  const exibivel = den >= min && den > 0;
  return {
    valor: exibivel ? num / den : null,
    exibivel,
    fracao: `${num}/${den}`,
    n: den,
  };
}
```

- [ ] **Step 4: Rodar (passa)** — `heavy bun run test src/lib/route/painel/__tests__/gating.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/route/painel/gating.ts src/lib/route/painel/__tests__/gating.test.ts
git commit -m "feat(rota-painel): taxaComGating — freio de baixo volume (TDD)"
```

---

## Task 4: Helper `agregarPainel` (TDD) — núcleo

**Files:** Create `src/lib/route/painel/agregar.ts` + `__tests__/agregar.test.ts`

> Junção por `(data_rota, farmer_id, customer_user_id)`. Cobertura/gap = LIGAÇÃO (snapshot é a fila de ligação). Eficácia global + por bucket/vendedora = sobre contatos de **ligação**; `por_canal` usa **todos** os canais. Dia com contato de ligação sem snapshot → conta em `dias_sem_denominador` e NÃO infla cobertura.

- [ ] **Step 1: Teste (falha)**

```ts
// src/lib/route/painel/__tests__/agregar.test.ts
import { describe, it, expect } from 'vitest';
import { agregarPainel } from '../agregar';
import type { SnapshotRow, ContatoRow } from '../types';

const snap = (over: Partial<SnapshotRow>): SnapshotRow => ({
  data_rota: '2026-06-03', farmer_id: 'r', customer_user_id: 'c1',
  cidade: 'DIVINOPOLIS (MG)', bucket: 'top', valor_da_ligacao: 100, rank: 1, ...over,
});
const ct = (over: Partial<ContatoRow>): ContatoRow => ({
  data_rota: '2026-06-03', farmer_id: 'r', customer_user_id: 'c1',
  canal: 'ligacao', status: 'respondido', valor_da_ligacao: 100, bucket: 'top', ...over,
});

describe('agregarPainel', () => {
  it('cobertura: 2 elegíveis, 1 contatado → 1/2; gap = valor do não-contatado', () => {
    const snaps = [snap({ customer_user_id: 'c1', valor_da_ligacao: 100 }),
                   snap({ customer_user_id: 'c2', valor_da_ligacao: 60 })];
    const contatos = [ct({ customer_user_id: 'c1' })];
    const r = agregarPainel(snaps, contatos);
    expect(r.elegiveis_n).toBe(2);
    expect(r.contatados_n).toBe(1);
    expect(r.cobertura_count.fracao).toBe('1/2');
    expect(r.elegiveis_valor).toBe(160);
    expect(r.contatados_valor).toBe(100);
    expect(r.gap_valor).toBe(60);   // c2 não contatado
  });

  it('eficácia global: conversão/resposta/optout sobre contatos de ligação', () => {
    const snaps = [snap({ customer_user_id: 'c1' }), snap({ customer_user_id: 'c2' }), snap({ customer_user_id: 'c3' })];
    const contatos = [
      ct({ customer_user_id: 'c1', status: 'convertido', valor_da_ligacao: 100 }),
      ct({ customer_user_id: 'c2', status: 'sem_resposta' }),
      ct({ customer_user_id: 'c3', status: 'opt_out' }),
    ];
    const r = agregarPainel(snaps, contatos);
    expect(r.global.contatos).toBe(3);
    expect(r.global.resposta.fracao).toBe('1/3');     // só convertido conta como atendido aqui
    expect(r.global.conversao.fracao).toBe('1/3');
    expect(r.global.optout.fracao).toBe('1/3');
    expect(r.global.valor_capturado).toBe(100);       // valor da convertida
    expect(r.global.conversao.exibivel).toBe(false);  // n=3 < 30
  });

  it('dia com contato de ligação SEM snapshot → dias_sem_denominador, não infla cobertura', () => {
    const snaps = [snap({ data_rota: '2026-06-03', customer_user_id: 'c1' })];
    const contatos = [
      ct({ data_rota: '2026-06-03', customer_user_id: 'c1' }),               // tem snapshot
      ct({ data_rota: '2026-06-04', customer_user_id: 'cX' }),               // SEM snapshot nesse dia
    ];
    const r = agregarPainel(snaps, contatos);
    expect(r.elegiveis_n).toBe(1);
    expect(r.contatados_n).toBe(1);            // só o que casa com snapshot
    expect(r.cobertura_count.fracao).toBe('1/1');
    expect(r.dias_sem_denominador).toBe(1);    // 2026-06-04
  });

  it('por_canal separa ligação e whatsapp; por_vendedora agrupa por farmer', () => {
    const snaps = [snap({ customer_user_id: 'c1' })];
    const contatos = [
      ct({ canal: 'ligacao', farmer_id: 'r', status: 'convertido' }),
      ct({ canal: 'whatsapp', farmer_id: 't', customer_user_id: 'c9', status: 'respondido' }),
    ];
    const r = agregarPainel(snaps, contatos);
    expect(r.por_canal.map(g => g.chave).sort()).toEqual(['ligacao', 'whatsapp']);
    expect(r.por_vendedora.map(g => g.chave).sort()).toEqual(['r', 't']);
  });

  it('vazio → zeros, sem divisão por zero', () => {
    const r = agregarPainel([], []);
    expect(r.elegiveis_n).toBe(0);
    expect(r.gap_valor).toBe(0);
    expect(r.contatos_por_dia).toBe(0);
    expect(r.global.conversao.valor).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar (falha)** — `heavy bun run test src/lib/route/painel/__tests__/agregar.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/route/painel/agregar.ts
import type { SnapshotRow, ContatoRow, PainelAgregado, GrupoEficacia } from './types';
import { taxaComGating } from './gating';

const key = (d: string, f: string | null, c: string | null) => `${d}|${f ?? ''}|${c ?? ''}`;
const num = (x: number | null | undefined) => (typeof x === 'number' && isFinite(x) ? x : 0);

function grupo(chave: string, contatos: ContatoRow[]): GrupoEficacia {
  const n = contatos.length;
  const convertido = contatos.filter((c) => c.status === 'convertido').length;
  const atendido = contatos.filter((c) => c.status === 'respondido' || c.status === 'convertido').length;
  const optout = contatos.filter((c) => c.status === 'opt_out').length;
  const valor_capturado = contatos.filter((c) => c.status === 'convertido').reduce((s, c) => s + num(c.valor_da_ligacao), 0);
  return {
    chave, contatos: n,
    resposta: taxaComGating(atendido, n),
    conversao: taxaComGating(convertido, n),
    optout: taxaComGating(optout, n),
    valor_capturado,
  };
}

function agrupar(contatos: ContatoRow[], chaveDe: (c: ContatoRow) => string): GrupoEficacia[] {
  const m = new Map<string, ContatoRow[]>();
  for (const c of contatos) {
    const k = chaveDe(c);
    const arr = m.get(k); if (arr) arr.push(c); else m.set(k, [c]);
  }
  return [...m.entries()].map(([k, cs]) => grupo(k, cs));
}

export function agregarPainel(snapshots: SnapshotRow[], contatos: ContatoRow[]): PainelAgregado {
  // índice de elegíveis (snapshot) por chave
  const snapByKey = new Map<string, SnapshotRow>();
  for (const s of snapshots) snapByKey.set(key(s.data_rota, s.farmer_id, s.customer_user_id), s);

  // contatos de ligação que casam com um snapshot → "contatados"
  const ligacoes = contatos.filter((c) => c.canal === 'ligacao');
  const contatadasKeys = new Set<string>();
  for (const c of ligacoes) {
    const k = key(c.data_rota, c.farmer_id, c.customer_user_id);
    if (snapByKey.has(k)) contatadasKeys.add(k);
  }

  const elegiveis_n = snapshots.length;
  const contatados_n = contatadasKeys.size;
  const elegiveis_valor = snapshots.reduce((s, e) => s + num(e.valor_da_ligacao), 0);
  const contatados_valor = snapshots
    .filter((e) => contatadasKeys.has(key(e.data_rota, e.farmer_id, e.customer_user_id)))
    .reduce((s, e) => s + num(e.valor_da_ligacao), 0);
  const gap_valor = elegiveis_valor - contatados_valor;

  // dias com snapshot (denominador disponível) vs dias com contato-de-ligação sem snapshot
  const diasComSnapshot = new Set(snapshots.map((s) => s.data_rota));
  const diasContatoLigacao = new Set(ligacoes.map((c) => c.data_rota));
  const dias_sem_denominador = [...diasContatoLigacao].filter((d) => !diasComSnapshot.has(d)).length;

  // capacidade: contatos de ligação por dia (sobre dias COM dado de contato)
  const contatos_total = ligacoes.length;
  const dias_com_dado = diasContatoLigacao.size;
  const contatos_por_dia = dias_com_dado > 0 ? contatos_total / dias_com_dado : 0;

  return {
    elegiveis_n,
    contatados_n,
    cobertura_count: taxaComGating(contatados_n, elegiveis_n, 1), // cobertura: min=1 (sempre exibe se há fila)
    elegiveis_valor,
    contatados_valor,
    gap_valor,
    contatos_total,
    dias_com_dado,
    contatos_por_dia,
    dias_sem_denominador,
    global: grupo('global', ligacoes),
    por_vendedora: agrupar(ligacoes, (c) => c.farmer_id ?? '—'),
    por_bucket: agrupar(ligacoes, (c) => c.bucket ?? '—'),
    por_canal: agrupar(contatos, (c) => c.canal),  // TODOS os canais
  };
}
```

- [ ] **Step 4: Rodar (passa)** — `heavy bun run test src/lib/route/painel/__tests__/agregar.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/route/painel/agregar.ts src/lib/route/painel/__tests__/agregar.test.ts
git commit -m "feat(rota-painel): agregarPainel — cobertura/gap/eficácia/cortes (TDD)"
```

---

## Task 5: Snapshot on-open (grava a fila que a vendedora viu)

**Files:** Create `src/queries/useSnapshotRouteQueue.ts`; Modify `src/pages/RotaListaLigacao.tsx`

> Best-effort: falha NUNCA quebra a lista. Idempotente (`onConflict` ignora duplicados). `farmer_id` = o usuário logado (o visualizador). `cidade` vem de `item.cityKey.city`.

- [ ] **Step 1: Hook de escrita**

```ts
// src/queries/useSnapshotRouteQueue.ts
import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { RouteContactItem } from '@/queries/useRouteContactList';

/** Grava (idempotente, best-effort) a fila de ligação que o farmer ABRIU — denominador do painel. */
export function useSnapshotRouteQueue(routeDate: string | null, callQueue: RouteContactItem[] | undefined) {
  const { user } = useAuth();
  const feito = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !routeDate || !callQueue || callQueue.length === 0) return;
    const marca = `${routeDate}:${user.id}`;
    if (feito.current === marca) return;       // 1x por (dia, usuário) por montagem
    feito.current = marca;
    const rows = callQueue.map((it, i) => ({
      data_rota: routeDate,
      farmer_id: user.id,
      customer_user_id: it.customerUserId,
      cidade: it.cityKey?.city ?? null,
      bucket: it.bucket,
      valor_da_ligacao: it.valorDaLigacao,
      rank: i + 1,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (supabase.from('route_queue_snapshot' as never) as any)
      .upsert(rows as never, { onConflict: 'data_rota,farmer_id,customer_user_id', ignoreDuplicates: true })
      .then(() => { /* best-effort */ }, () => { feito.current = null; /* permite retry numa próxima montagem */ });
  }, [user, routeDate, callQueue]);
}
```

- [ ] **Step 2: Chamar em RotaListaLigacao** — adicionar o import e a chamada (após `const { data, isLoading } = useRouteContactList(workday);`):

```tsx
import { useSnapshotRouteQueue } from '@/queries/useSnapshotRouteQueue';
// ...dentro do componente, depois de obter `data`:
useSnapshotRouteQueue(data?.routeDate ?? null, data?.callQueue);
```

(Chamar o hook incondicionalmente — ele já trata `undefined`/vazio internamente; não pode ficar atrás do `if (isLoading) return`. Posicionar a chamada ANTES de qualquer `return`.)

- [ ] **Step 3: Typecheck + lint** — `heavy bun run typecheck && bun lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/queries/useSnapshotRouteQueue.ts src/pages/RotaListaLigacao.tsx
git commit -m "feat(rota-painel): snapshot on-open da fila de ligação (denominador)"
```

---

## Task 6: Hook de leitura `useRoutePanel`

**Files:** Create `src/queries/useRoutePanel.ts`

> Lê snapshot + log no período (paginado — passam de 1000), chama `agregarPainel`. Período = N dias por `data_rota`.

- [ ] **Step 1: Implementar**

```ts
// src/queries/useRoutePanel.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { spBusinessDate } from '@/lib/time/sp-day';
import { agregarPainel } from '@/lib/route/painel/agregar';
import type { SnapshotRow, ContatoRow, PainelAgregado } from '@/lib/route/painel/types';

const PAGE = 1000;

async function lerTudo<T>(tabela: string, cols: string, desdeISO: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from(tabela as never) as any)
      .select(cols).gte('data_rota', desdeISO)
      .order('data_rota', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    const arr = (data ?? []) as T[];
    out.push(...arr);
    if (arr.length < PAGE) break;
  }
  return out;
}

/** dias = janela (default 30) terminando hoje (SP). */
export function useRoutePanel(dias = 30) {
  return useQuery({
    queryKey: ['route-panel', dias],
    staleTime: 60_000,
    queryFn: async (): Promise<PainelAgregado> => {
      const hoje = spBusinessDate(new Date());
      const d = new Date(hoje + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - (dias - 1));
      const desde = spBusinessDate(d);
      const [snaps, contatos] = await Promise.all([
        lerTudo<SnapshotRow>('route_queue_snapshot', 'data_rota, farmer_id, customer_user_id, cidade, bucket, valor_da_ligacao, rank', desde),
        lerTudo<ContatoRow>('route_contact_log', 'data_rota, farmer_id, customer_user_id, canal, status, valor_da_ligacao, bucket', desde),
      ]);
      return agregarPainel(snaps, contatos);
    },
  });
}
```

- [ ] **Step 2: Typecheck** — `heavy bun run typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/queries/useRoutePanel.ts
git commit -m "feat(rota-painel): useRoutePanel (lê snapshot+log paginado → agrega)"
```

---

## Task 7: Página `RotaPainelLigacoes` + rota + link

**Files:** Create `src/pages/RotaPainelLigacoes.tsx`; Modify `src/App.tsx`, `src/pages/RotaListaLigacao.tsx`

> Gate master/gestor (`useAuth().isMaster || isGestorComercial`). Headline (cobertura, **gap de valor**, capacidade) + eficácia (rótulos honestos, gating) + guardrail opt-out + cortes + seletor de período + banner "piloto/direcional". Mapa de rótulos de vendedora (id→nome) via `useSalespeople`.

- [ ] **Step 1: Implementar a página**

```tsx
// src/pages/RotaPainelLigacoes.tsx
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useRoutePanel } from '@/queries/useRoutePanel';
import { useSalespeople } from '@/hooks/useCoverage';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { GrupoEficacia, TaxaGated } from '@/lib/route/painel/types';

const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const fmtTaxa = (t: TaxaGated) => t.exibivel && t.valor != null
  ? `${(t.valor * 100).toFixed(0)}%`
  : `${t.fracao} · amostra baixa`;

const BUCKET_LABEL: Record<string, string> = { top: 'Prioridade', winback: 'Recuperar', coldstart: 'Novo cliente', '—': '—' };
const CANAL_LABEL: Record<string, string> = { ligacao: 'Ligação', whatsapp: 'WhatsApp' };

export default function RotaPainelLigacoes() {
  const { isMaster, isGestorComercial } = useAuth();
  const [dias, setDias] = useState(30);
  const { data: p, isLoading } = useRoutePanel(dias);
  const { data: salespeople = [] } = useSalespeople();
  const nomeVend = (id: string) => salespeople.find((s) => s.user_id === id)?.name ?? id.slice(0, 8);

  if (!isMaster && !isGestorComercial) return <Navigate to="/" replace />;
  if (isLoading || !p) return <PageSkeleton variant="cockpit" />;

  const semDado = p.elegiveis_n === 0 && p.contatos_total === 0;

  return (
    <div className="container py-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Painel das ligações da rota</h1>
          <p className="text-2xs text-muted-foreground">
            Cobertura × eficácia do programa de ligações. <Badge variant="outline" className="text-status-warning">piloto · direcional</Badge>
          </p>
        </div>
        <Select value={String(dias)} onValueChange={(v) => setDias(Number(v))}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 dias</SelectItem>
            <SelectItem value="30">30 dias</SelectItem>
            <SelectItem value="90">90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {semDado ? (
        <Card className="p-6 text-sm text-muted-foreground">Sem dados no período ainda. O painel preenche conforme as vendedoras abrem a lista e registram as ligações.</Card>
      ) : (
        <>
          {/* Headline: cobertura + gap + capacidade */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card className="p-4">
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Cobertura da fila</div>
              <div className="kpi-value text-2xl">{fmtTaxa(p.cobertura_count)}</div>
              <div className="text-2xs text-muted-foreground">{p.contatados_n} de {p.elegiveis_n} elegíveis contatados</div>
              <div className="text-2xs text-muted-foreground">por valor: {fmtBRL(p.contatados_valor)} de {fmtBRL(p.elegiveis_valor)}</div>
            </Card>
            <Card className="p-4 border-status-warning/40">
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Valor esperado sem contato</div>
              <div className="kpi-value text-2xl text-status-warning">{fmtBRL(p.gap_valor)}</div>
              <div className="text-2xs text-muted-foreground">o que a equipe não alcançou (score esperado, não R$)</div>
            </Card>
            <Card className="p-4">
              <div className="text-2xs uppercase tracking-wide text-muted-foreground">Capacidade</div>
              <div className="kpi-value text-2xl">{p.contatos_por_dia.toFixed(1)}<span className="text-sm">/dia</span></div>
              <div className="text-2xs text-muted-foreground">{p.contatos_total} ligações em {p.dias_com_dado} dia(s)</div>
              {p.dias_sem_denominador > 0 && <div className="text-2xs text-status-warning">{p.dias_sem_denominador} dia(s) sem denominador (lista não aberta)</div>}
            </Card>
          </div>

          {/* Eficácia global */}
          <Card className="p-4">
            <div className="text-sm font-semibold mb-2">Eficácia das ligações (reportada pela vendedora)</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div><div className="text-2xs text-muted-foreground">Atendimento</div><div className="kpi-value text-lg">{fmtTaxa(p.global.resposta)}</div></div>
              <div><div className="text-2xs text-muted-foreground">Conversão reportada</div><div className="kpi-value text-lg">{fmtTaxa(p.global.conversao)}</div></div>
              <div><div className="text-2xs text-muted-foreground">Opt-out (guardrail)</div><div className="kpi-value text-lg text-status-error">{fmtTaxa(p.global.optout)}</div></div>
            </div>
            <div className="text-2xs text-muted-foreground mt-2">Valor esperado convertido: {fmtBRL(p.global.valor_capturado)} · atendimento inclui convertidos.</div>
          </Card>

          {/* Cortes */}
          <CorteCard titulo="Por vendedora" aviso="comparação crua engana se o mix de cidade/bucket difere" grupos={p.por_vendedora} rotulo={nomeVend} />
          <CorteCard titulo="Por bucket" grupos={p.por_bucket} rotulo={(k) => BUCKET_LABEL[k] ?? k} />
          <CorteCard titulo="Por canal" grupos={p.por_canal} rotulo={(k) => CANAL_LABEL[k] ?? k} />
        </>
      )}
    </div>
  );
}

function CorteCard({ titulo, aviso, grupos, rotulo }: {
  titulo: string; aviso?: string; grupos: GrupoEficacia[]; rotulo: (k: string) => string;
}) {
  const fmtTaxa = (t: TaxaGated) => t.exibivel && t.valor != null ? `${(t.valor * 100).toFixed(0)}%` : `${t.fracao}·baixa`;
  return (
    <Card className="p-4">
      <div className="text-sm font-semibold">{titulo}</div>
      {aviso && <div className="text-2xs text-status-warning mb-1">⚠ {aviso}</div>}
      <div className="divide-y divide-border">
        {grupos.length === 0 && <div className="text-2xs text-muted-foreground py-2">sem dados</div>}
        {grupos.map((g) => (
          <div key={g.chave} className="py-2 flex items-center justify-between gap-2 text-sm">
            <span className="font-medium truncate">{rotulo(g.chave)}</span>
            <div className="flex items-center gap-3 text-2xs text-muted-foreground shrink-0">
              <span>{g.contatos} contatos</span>
              <span>conv {fmtTaxa(g.conversao)}</span>
              <span>opt-out {fmtTaxa(g.optout)}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Rota em App.tsx** — adicionar o lazy import + a rota (irmã de `rota/ligacoes`, dentro do mesmo grupo de rotas staff):

```tsx
const RotaPainelLigacoes = lazy(() => import("./pages/RotaPainelLigacoes"));
// ...na lista de rotas, perto da rota/ligacoes:
<Route path="rota/ligacoes/painel" element={<RotaPainelLigacoes />} />
```

- [ ] **Step 3: Link na RotaListaLigacao** — adicionar um link discreto pro painel no topo (master/gestor). No `RotaListaLigacao`, importar `useAuth` + `Link`, e no header:

```tsx
{(isMaster || isGestorComercial) && (
  <Link to="/rota/ligacoes/painel" className="text-2xs text-status-info underline">Ver painel</Link>
)}
```

(obter `const { isMaster, isGestorComercial } = useAuth();` no componente).

- [ ] **Step 4: Typecheck + lint** — `heavy bun run typecheck && bun lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/RotaPainelLigacoes.tsx src/App.tsx src/pages/RotaListaLigacao.tsx
git commit -m "feat(rota-painel): página do painel + rota + link"
```

---

## Task 8: Gate de CI completo + roadmap/spec

**Files:** Modify `docs/roadmap-sessao.md`, `docs/superpowers/specs/2026-06-04-painel-ligacoes-rota-design.md`

- [ ] **Step 1: GATE COMPLETO** (todos têm que passar):
  - `heavy bun run typecheck`
  - `heavy bun run test`
  - `bun lint`
  - `heavy bun run build`
  Se algo falhar por causa da feature, consertar. Teste pré-existente alheio quebrando → reportar, não consertar.

- [ ] **Step 2: Atualizar docs** — spec Status → "plano + implementado; aguarda migration (SQL Editor) + Publish + QA"; roadmap: adicionar seção 5 (Painel) com ✅ spec/plano/build, ⏳ migration+publish+QA.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap-sessao.md docs/superpowers/specs/2026-06-04-painel-ligacoes-rota-design.md
git commit -m "feat(rota-painel): gate CI verde + atualiza roadmap/spec"
```

- [ ] **Step 4: QA manual (founder, pós-migration + Publish)** — abrir `/rota/ligacoes` como vendedora (gera snapshot) → registrar algumas ligações → abrir `/rota/ligacoes/painel` (master): conferir cobertura (contatados/elegíveis), gap de valor, capacidade/dia, eficácia com gating (poucos dados → "x/y amostra baixa"), opt-out, cortes. Dia sem abrir a lista → "sem denominador".

---

## Self-Review (executado ao escrever)

**Spec coverage:** §2 denominador → Task 1 (tabela) + Task 5 (snapshot on-open). §4 métricas → Task 4 (`agregarPainel`). §3.4 gating → Task 3. §3.5 opt-out guardrail → Task 7 (card). §3.6 cortes (vendedora c/ aviso de mix, bucket, canal) → Task 4 + Task 7. §3.7 fuso/`data_rota` → Tasks 4/6 (`spBusinessDate`, join por data_rota). §7 degradação (dia sem snapshot) → Task 4 (`dias_sem_denominador`). Gate master/gestor → Task 7.

**Type consistency:** `SnapshotRow`/`ContatoRow`/`PainelAgregado`/`GrupoEficacia`/`TaxaGated` (Task 2) usados em 3/4/6/7. `taxaComGating`/`agregarPainel` assinaturas estáveis. ⚠️ **camelCase↔snake_case:** o item da fila é `customerUserId`/`valorDaLigacao`/`cityKey.city`/`bucket` (camelCase) → o snapshot grava `customer_user_id`/`valor_da_ligacao`/`cidade`/`bucket` (snake) — mapeado no Task 5.

**Placeholders:** nenhum — todo step tem código/SQL/comando reais.

**Risco conhecido:** cobertura usa min=1 no gating (sempre exibe se há fila); eficácia usa min=30 (piloto → quase tudo "amostra baixa" no começo, que é o comportamento HONESTO desejado). `por_canal` inclui todos os canais (whatsapp aparece se houver log, mesmo sem snapshot — coverage é só ligação por design v1).
