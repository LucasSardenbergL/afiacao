# Carteira-Omie — Sub-PR D (Positivação & KPIs, Fase 4 v1) — Implementation Plan

> **✅ CONCLUÍDO (2026-05-25):** Tasks 1-9 implementadas (PR #279 mergeada na main, squash `7ac27cc`→`892a740`). Rollout aplicado e validado em produção no Lovable: BLOCO A (col=1/snap=1/rpc=1) → deploy de `omie-vendas-sync` + `carteira-positivacao-snapshot` → RPC validada (carteira elegível Regina ~1890) → cron `carteira-positivacao-snapshot-mensal` (`0 8 1 * *`) ativo → smoke test ok. 1018 testes verdes + typecheck:strict. **Programa Carteira-Omie (A+B+D) 100% em produção.** Dívida conhecida: pedidos antigos sem payload Omie → `order_date_kpi = created_at`; corrige conforme re-syncs gravam `dInc`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** A tela `FarmerCalls` passa a liderar com KPIs de progresso comercial da carteira — Positivação MTD e a lista "Clientes a Positivar" como o coração — em vez de KPIs de atividade do dia.

**Architecture:** A SQL é dona da verdade via RPC `SECURITY DEFINER` `get_minha_positivacao()` (denominador elegível, `EXISTS` de pedido válido no mês, agregados, lista candidata) — usa `auth.uid()`, sem param (anti-IDOR). Helpers puros TDD em `src/lib/positivacao/` só formatam/ordenam. Snapshot mensal (tabela + cron) provisionado pra história; UI histórica fica de fora da v1.

**Tech Stack:** Supabase Postgres (migration manual Lovable + RPC), Deno edge functions (deploy via chat Lovable), React + @tanstack/react-query + Vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-carteira-positivacao-kpis-design.md`.
**Pré-requisito:** Sub-PR B em produção (`farmer_client_scores`/`customer_visit_scores` = 1 linha/cliente, `farmer_id` = dono). Branch: `feat/carteira-positivacao-kpis` (a partir de `main`).

---

## Pré-requisitos operacionais
- DB só via Lovable SQL Editor (migration manual, 1 bloco/mensagem, validação no fim).
- Edge functions deployadas via chat do Lovable (EDIT lê o arquivo do repo na `main`).
- `bun run test` (vitest) é canônico. `heavy` antes de test/typecheck/build (máquina satura).
- **Anti-vanity:** a lista "quem não comprou e vale agir" domina a tela; KPIs de atividade são rebaixados.

## File Structure

| Arquivo | Mudança |
|---|---|
| `src/lib/positivacao/month.ts` + `__tests__/month.test.ts` (criar) | `mesComercialCorrente(now, tz)` → `{ inicioIso, fimIso }` (fronteira do mês em America/Sao_Paulo). |
| `src/lib/positivacao/format.ts` + `__tests__/format.test.ts` (criar) | `pctPositivacao`, `ticketMedio`, `pctCobertura` — null/zero-safe. |
| `src/lib/positivacao/ranking.ts` + `__tests__/ranking.test.ts` (criar) | `rankAPositivar(candidatos)` — ordena por prioridade comercial. |
| `src/lib/positivacao/types.ts` (criar) | tipos `PositivacaoResumo`, `ClienteAPositivar` (espelham o retorno da RPC). |
| `supabase/migrations/<ts>_positivacao_kpis.sql` (criar) | coluna `order_date_kpi` + backfill + índice + tabela `carteira_positivacao_snapshot` + RPC `get_minha_positivacao()`. |
| `supabase/functions/omie-vendas-sync/index.ts` (modificar) | grava `order_date_kpi` de `infoCadastro.dInc`. |
| `supabase/functions/carteira-positivacao-snapshot/index.ts` (criar) | cron mensal: materializa o mês fechado em `carteira_positivacao_snapshot`. |
| `src/hooks/useMyPositivacao.ts` (criar) | chama a RPC + aplica helpers; expõe KPIs + lista. |
| `src/components/farmer/PositivacaoHero.tsx` (criar) | cards de KPI do hero (Farmer/Hunter). |
| `src/components/farmer/ClientesAPositivarCard.tsx` (criar) | lista acionável (reusa visual do `VisitSuggestionsCard`). |
| `src/pages/FarmerCalls.tsx` (modificar) | monta os heros + lista no topo; rebaixa os KPIs de atividade. |

---

## Task 1: Helper de mês comercial (TDD)

**Files:** Create `src/lib/positivacao/month.ts`, `src/lib/positivacao/__tests__/month.test.ts`

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/positivacao/__tests__/month.test.ts
import { describe, it, expect } from 'vitest';
import { mesComercialCorrente } from '../month';

describe('mesComercialCorrente (MTD, America/Sao_Paulo)', () => {
  it('retorna 1º dia do mês e 1º dia do mês seguinte (datas ISO yyyy-mm-dd)', () => {
    // 2026-05-15T12:00:00Z → ainda 15/mai em BRT
    const r = mesComercialCorrente(new Date('2026-05-15T12:00:00Z'));
    expect(r.inicioIso).toBe('2026-05-01');
    expect(r.fimIso).toBe('2026-06-01');
  });
  it('vira o mês corretamente perto da meia-noite UTC (offset BRT -3)', () => {
    // 2026-06-01T02:00:00Z = 31/mai 23:00 BRT → ainda mês de maio
    const r = mesComercialCorrente(new Date('2026-06-01T02:00:00Z'));
    expect(r.inicioIso).toBe('2026-05-01');
    expect(r.fimIso).toBe('2026-06-01');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/lib/positivacao/__tests__/month.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

```ts
// src/lib/positivacao/month.ts
/** Fronteira do mês comercial corrente (MTD) no fuso America/Sao_Paulo, como datas ISO yyyy-mm-dd. */
export function mesComercialCorrente(now: Date = new Date()): { inicioIso: string; fimIso: string } {
  // Converte 'now' pra data-local de São Paulo via Intl (robusto a DST/offset).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [{ value: y }, , { value: m }] = fmt.formatToParts(now).filter(p => p.type === 'year' || p.type === 'month' || p.type === 'day');
  const year = Number(y);
  const month = Number(m); // 1-12
  const inicio = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const fim = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return { inicioIso: inicio, fimIso: fim };
}
```

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test src/lib/positivacao/__tests__/month.test.ts` → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/positivacao/month.ts src/lib/positivacao/__tests__/month.test.ts
git commit -m "feat(positivacao): helper mesComercialCorrente (MTD BRT) + testes"
```

---

## Task 2: Helpers de formatação (TDD)

**Files:** Create `src/lib/positivacao/format.ts`, `src/lib/positivacao/__tests__/format.test.ts`

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/positivacao/__tests__/format.test.ts
import { describe, it, expect } from 'vitest';
import { pctPositivacao, ticketMedio, pctCobertura } from '../format';

describe('format positivação (null/zero-safe)', () => {
  it('pctPositivacao = positivados/elegiveis*100, arredondado a 1 casa', () => {
    expect(pctPositivacao(540, 1890)).toBe(28.6);
    expect(pctPositivacao(0, 0)).toBe(0);     // sem carteira → 0, não NaN
    expect(pctPositivacao(5, 0)).toBe(0);
  });
  it('ticketMedio = receita/compradores; 0 compradores → 0', () => {
    expect(ticketMedio(10000, 4)).toBe(2500);
    expect(ticketMedio(10000, 0)).toBe(0);
  });
  it('pctCobertura idem pctPositivacao', () => {
    expect(pctCobertura(800, 1890)).toBe(42.3);
    expect(pctCobertura(0, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/lib/positivacao/__tests__/format.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/positivacao/format.ts
function pct(num: number, den: number): number {
  if (!den || den <= 0) return 0;
  return Math.round((num / den) * 1000) / 10;
}
export const pctPositivacao = pct;
export const pctCobertura = pct;

export function ticketMedio(receita: number, compradores: number): number {
  if (!compradores || compradores <= 0) return 0;
  return Math.round((receita / compradores) * 100) / 100;
}
```

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test src/lib/positivacao/__tests__/format.test.ts` → 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/positivacao/format.ts src/lib/positivacao/__tests__/format.test.ts
git commit -m "feat(positivacao): helpers de formatação null-safe + testes"
```

---

## Task 3: Tipos + ranking da lista "a positivar" (TDD)

**Files:** Create `src/lib/positivacao/types.ts`, `src/lib/positivacao/ranking.ts`, `src/lib/positivacao/__tests__/ranking.test.ts`

> A RPC (Task 4) devolve candidatos crus; o ranking é função pura, fácil de testar e ajustar.

- [ ] **Step 1: Tipos**

```ts
// src/lib/positivacao/types.ts
export interface ClienteAPositivar {
  customer_user_id: string;
  nome: string | null;
  revenue_potential: number | null;
  churn_risk: number | null;
  recover_score: number | null;
  days_since_last_purchase: number | null;
  priority_score: number | null;
}

export interface PositivacaoResumo {
  mes: string;                       // yyyy-mm-01
  total_eligible: number;
  positivados: number;
  compradores_mtd: number;
  receita_mtd: number;
  contatados_mtd: number;
  recencia_critica: number;
  novos_clientes_positivados: number;
  a_positivar: ClienteAPositivar[];
}
```

- [ ] **Step 2: Teste que falha**

```ts
// src/lib/positivacao/__tests__/ranking.test.ts
import { describe, it, expect } from 'vitest';
import { rankAPositivar } from '../ranking';
import type { ClienteAPositivar } from '../types';

const c = (over: Partial<ClienteAPositivar>): ClienteAPositivar => ({
  customer_user_id: 'x', nome: null, revenue_potential: 0, churn_risk: 0,
  recover_score: 0, days_since_last_purchase: 0, priority_score: 0, ...over,
});

describe('rankAPositivar', () => {
  it('prioriza maior priority_score, depois maior revenue_potential', () => {
    const out = rankAPositivar([
      c({ customer_user_id: 'a', priority_score: 10, revenue_potential: 100 }),
      c({ customer_user_id: 'b', priority_score: 90, revenue_potential: 1 }),
      c({ customer_user_id: 'c', priority_score: 90, revenue_potential: 500 }),
    ]);
    expect(out.map(x => x.customer_user_id)).toEqual(['c', 'b', 'a']);
  });
  it('não muta o array de entrada', () => {
    const input = [c({ customer_user_id: 'a', priority_score: 1 }), c({ customer_user_id: 'b', priority_score: 2 })];
    rankAPositivar(input);
    expect(input.map(x => x.customer_user_id)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar** — `heavy bun run test src/lib/positivacao/__tests__/ranking.test.ts` → FAIL.

- [ ] **Step 4: Implementar**

```ts
// src/lib/positivacao/ranking.ts
import type { ClienteAPositivar } from './types';

/** Ordena candidatos "a positivar" por prioridade comercial (não muta a entrada). */
export function rankAPositivar(candidatos: ClienteAPositivar[]): ClienteAPositivar[] {
  return [...candidatos].sort((a, b) => {
    const ps = (b.priority_score ?? 0) - (a.priority_score ?? 0);
    if (ps !== 0) return ps;
    const rp = (b.revenue_potential ?? 0) - (a.revenue_potential ?? 0);
    if (rp !== 0) return rp;
    return (b.churn_risk ?? 0) - (a.churn_risk ?? 0);
  });
}
```

- [ ] **Step 5: Rodar e ver passar** — `heavy bun run test src/lib/positivacao/__tests__/ranking.test.ts` → 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/positivacao/types.ts src/lib/positivacao/ranking.ts src/lib/positivacao/__tests__/ranking.test.ts
git commit -m "feat(positivacao): tipos + rankAPositivar puro + testes"
```

---

## Task 4: Migration — coluna order_date_kpi + snapshot + RPC

**Files:** Create `supabase/migrations/20260525120000_positivacao_kpis.sql`

> DB via Lovable. O arquivo é committado; o SQL é entregue como BLOCO no rollout (Task 8). RPC validada via SQL (sem teste automatizado).

- [ ] **Step 1: Escrever a migration**

```sql
-- 20260525120000_positivacao_kpis.sql
-- Sub-PR D: data do pedido pra KPI + snapshot mensal + RPC de positivação.

-- 1. order_date_kpi (data do PEDIDO, não previsão de entrega)
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS order_date_kpi date;
UPDATE public.sales_orders SET order_date_kpi = created_at::date WHERE order_date_kpi IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_kpi_date ON public.sales_orders (order_date_kpi);

-- 2. snapshot mensal (congela posse/elegibilidade por mês fechado)
CREATE TABLE IF NOT EXISTS public.carteira_positivacao_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mes date NOT NULL,
  customer_user_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  eligible boolean NOT NULL,
  had_order_in_month boolean NOT NULL,
  first_order_date_in_month date,
  revenue_month numeric,
  contacted_in_month boolean NOT NULL DEFAULT false,
  visited_in_month boolean NOT NULL DEFAULT false,
  days_since_last_purchase_at_month_start int,
  churn_risk_at_month_start numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mes, customer_user_id)
);
ALTER TABLE public.carteira_positivacao_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff vê snapshot positivação" ON public.carteira_positivacao_snapshot;
CREATE POLICY "Staff vê snapshot positivação" ON public.carteira_positivacao_snapshot FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

-- 3. RPC de positivação do mês corrente (dono = auth.uid())
CREATE OR REPLACE FUNCTION public.get_minha_positivacao()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  mes_inicio date := date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date;
  mes_fim date := (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) + interval '1 month')::date;
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid, 'master'::app_role) OR has_role(uid, 'employee'::app_role)) THEN
    RETURN NULL;
  END IF;

  WITH eleg AS (
    SELECT ca.customer_user_id
    FROM public.carteira_assignments ca
    WHERE ca.owner_user_id = uid AND ca.eligible = true
  ),
  pedidos_validos AS (
    SELECT so.customer_user_id,
           COALESCE(so.order_date_kpi, so.created_at::date) AS d,
           so.total
    FROM public.sales_orders so
    WHERE so.status NOT IN ('cancelado','rascunho','pendente')
  ),
  pedidos_mes AS (
    SELECT pv.customer_user_id, sum(pv.total) AS receita
    FROM pedidos_validos pv
    JOIN eleg e ON e.customer_user_id = pv.customer_user_id
    WHERE pv.d >= mes_inicio AND pv.d < mes_fim
    GROUP BY pv.customer_user_id
  ),
  primeiro_pedido AS (
    SELECT pv.customer_user_id, min(pv.d) AS primeira
    FROM pedidos_validos pv
    JOIN eleg e ON e.customer_user_id = pv.customer_user_id
    GROUP BY pv.customer_user_id
  ),
  contato_mes AS (
    SELECT DISTINCT customer_user_id FROM (
      SELECT fc.customer_user_id FROM public.farmer_calls fc
        WHERE fc.farmer_id = uid AND fc.started_at >= mes_inicio AND fc.started_at < mes_fim
          AND fc.customer_user_id IS NOT NULL
      UNION
      SELECT rv.customer_user_id FROM public.route_visits rv
        WHERE rv.visited_by = uid AND rv.visit_date >= mes_inicio AND rv.visit_date < mes_fim
          AND rv.customer_user_id IS NOT NULL
    ) u
    JOIN eleg e USING (customer_user_id)
  ),
  scores AS (
    SELECT fcs.customer_user_id, fcs.revenue_potential, fcs.churn_risk,
           fcs.recover_score, fcs.days_since_last_purchase, fcs.priority_score,
           fcs.avg_repurchase_interval
    FROM public.farmer_client_scores fcs
    JOIN eleg e ON e.customer_user_id = fcs.customer_user_id
  ),
  a_positivar AS (
    SELECT s.customer_user_id,
           COALESCE(p.razao_social, p.name) AS nome,
           s.revenue_potential, s.churn_risk, s.recover_score,
           s.days_since_last_purchase, s.priority_score
    FROM scores s
    LEFT JOIN public.profiles p ON p.user_id = s.customer_user_id
    WHERE s.customer_user_id NOT IN (SELECT customer_user_id FROM pedidos_mes)
    ORDER BY s.priority_score DESC NULLS LAST, s.revenue_potential DESC NULLS LAST
    LIMIT 200
  )
  SELECT jsonb_build_object(
    'mes', to_char(mes_inicio, 'YYYY-MM-DD'),
    'total_eligible', (SELECT count(*) FROM eleg),
    'positivados', (SELECT count(*) FROM pedidos_mes),
    'compradores_mtd', (SELECT count(*) FROM pedidos_mes),
    'receita_mtd', COALESCE((SELECT sum(receita) FROM pedidos_mes), 0),
    'contatados_mtd', (SELECT count(*) FROM contato_mes),
    'recencia_critica', (
      SELECT count(*) FROM scores s
      WHERE COALESCE(s.churn_risk,0) >= 60
         OR (COALESCE(s.avg_repurchase_interval,0) > 0
             AND COALESCE(s.days_since_last_purchase,0) > s.avg_repurchase_interval * 1.5)
    ),
    'novos_clientes_positivados', (
      SELECT count(*) FROM primeiro_pedido pp
      WHERE pp.primeira >= mes_inicio AND pp.primeira < mes_fim
    ),
    'a_positivar', COALESCE((SELECT jsonb_agg(a_positivar) FROM a_positivar), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_minha_positivacao() TO authenticated;

SELECT 'BLOCO POSITIVACAO OK' AS status,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='sales_orders' AND column_name='order_date_kpi') AS col,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_name='carteira_positivacao_snapshot') AS snap,
  (SELECT count(*) FROM pg_proc WHERE proname='get_minha_positivacao') AS rpc;
```

> ⚠️ Conferir no rollout que `farmer_client_scores` tem a coluna `avg_repurchase_interval` (tem — ver schema-snapshot). `has_role` e `app_role` já existem (usados em outras RLS).

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260525120000_positivacao_kpis.sql
git commit -m "feat(positivacao): migration — order_date_kpi + snapshot + RPC get_minha_positivacao"
```

Entregar como BLOCO no rollout; esperado `col=1, snap=1, rpc=1`.

---

## Task 5: omie-vendas-sync grava order_date_kpi (dInc)

**Files:** Modify `supabase/functions/omie-vendas-sync/index.ts`

> Implementador lê o trecho do builder de linha importada (≈ linhas 1003-1035, onde `createdAt` é derivado de `data_previsao`). A interface do cabecalho já tem `infoCadastro?: { dInc?: string }` (≈ linha 89).

- [ ] **Step 1: Helper de parse de data dd/mm/yyyy → ISO**

No topo do arquivo (junto dos outros helpers), adicionar:

```ts
// dd/mm/yyyy → yyyy-mm-dd (date ISO); null se inválida
function parseOmieDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
```

- [ ] **Step 2: Setar order_date_kpi na linha importada**

No objeto que é dado `upsert` em `sales_orders` (onde já tem `created_at: createdAt`), adicionar o campo:

```ts
        // Data do PEDIDO pro KPI de positivação: dInc (inclusão no Omie) > previsão de entrega.
        order_date_kpi: parseOmieDate(cab.infoCadastro?.dInc) ?? parseOmieDate(cab.data_previsao) ?? createdAt.slice(0, 10),
```
(usar o nome real da var do cabecalho no escopo — `cab`; `createdAt` é string ISO já existente).

> Se a interface do cabecalho não tiver `infoCadastro`, adicionar `infoCadastro?: { dInc?: string };` ao tipo (já existe ≈ linha 89 — confirmar).

- [ ] **Step 3: Commit + deploy**

```bash
git add supabase/functions/omie-vendas-sync/index.ts
git commit -m "feat(positivacao): omie-vendas-sync grava order_date_kpi (dInc) p/ KPI por mês do pedido"
```
Deploy: entregar o arquivo final pro chat do Lovable (EDIT de `omie-vendas-sync`).

---

## Task 6: Edge function carteira-positivacao-snapshot (cron mensal)

**Files:** Create `supabase/functions/carteira-positivacao-snapshot/index.ts`

> Materializa o mês recém-fechado. Idempotente. Auth cron via `authorizeCronOrStaff` (padrão do projeto).

- [ ] **Step 1: Implementar**

```ts
// supabase/functions/carteira-positivacao-snapshot/index.ts
// Cron mensal (dia 1) — congela o mês FECHADO anterior em carteira_positivacao_snapshot.
// Idempotente (upsert por mes,customer_user_id). Auth via x-cron-secret OU staff.
import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // body opcional { mes: 'yyyy-mm-01' } pra backfill manual; default = mês anterior (BRT).
  const body = await req.json().catch(() => ({} as { mes?: string }));
  const nowBrt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const inicioMesAtual = new Date(nowBrt.getFullYear(), nowBrt.getMonth(), 1);
  const inicio = body.mes ? new Date(body.mes + 'T00:00:00') : new Date(inicioMesAtual.getFullYear(), inicioMesAtual.getMonth() - 1, 1);
  const fim = new Date(inicio.getFullYear(), inicio.getMonth() + 1, 1);
  const mesIso = `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, '0')}-01`;
  const inicioIso = mesIso;
  const fimIso = `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, '0')}-01`;

  // carteira (dono+elegibilidade de AGORA — melhor aproximação retroativa disponível)
  const assignments: Array<{ customer_user_id: string; owner_user_id: string; eligible: boolean }> = [];
  for (let p = 0; ; p++) {
    const { data } = await supabase.from('carteira_assignments')
      .select('customer_user_id, owner_user_id, eligible').range(p * 1000, p * 1000 + 999);
    const rows = (data ?? []) as typeof assignments;
    assignments.push(...rows);
    if (rows.length < 1000) break;
  }

  // pedidos válidos do mês por cliente (receita + 1ª data)
  const { data: pedidos } = await supabase.from('sales_orders')
    .select('customer_user_id, total, order_date_kpi, created_at, status')
    .not('status', 'in', '(cancelado,rascunho,pendente)');
  const byCustomer = new Map<string, { receita: number; primeira: string | null }>();
  for (const o of (pedidos ?? []) as Array<{ customer_user_id: string; total: number | null; order_date_kpi: string | null; created_at: string; status: string }>) {
    const d = (o.order_date_kpi ?? o.created_at.slice(0, 10));
    if (d >= inicioIso && d < fimIso) {
      const cur = byCustomer.get(o.customer_user_id) ?? { receita: 0, primeira: null };
      cur.receita += Number(o.total ?? 0);
      if (!cur.primeira || d < cur.primeira) cur.primeira = d;
      byCustomer.set(o.customer_user_id, cur);
    }
  }

  const rows = assignments.map(a => {
    const ped = byCustomer.get(a.customer_user_id);
    return {
      mes: mesIso,
      customer_user_id: a.customer_user_id,
      owner_user_id: a.owner_user_id,
      eligible: a.eligible,
      had_order_in_month: !!ped,
      first_order_date_in_month: ped?.primeira ?? null,
      revenue_month: ped?.receita ?? 0,
    };
  });

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('carteira_positivacao_snapshot')
      .upsert(rows.slice(i, i + 500), { onConflict: 'mes,customer_user_id' });
    if (!error) upserted += Math.min(500, rows.length - i);
  }

  return new Response(JSON.stringify({ mes: mesIso, upserted, total: rows.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Commit + deploy**

```bash
git add supabase/functions/carteira-positivacao-snapshot/index.ts
git commit -m "feat(positivacao): edge fn carteira-positivacao-snapshot (cron mensal idempotente)"
```
Deploy: entregar pro chat do Lovable (CREATE nova function).

---

## Task 7: Hook useMyPositivacao

**Files:** Create `src/hooks/useMyPositivacao.ts`

- [ ] **Step 1: Implementar**

```ts
// src/hooks/useMyPositivacao.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { rankAPositivar } from '@/lib/positivacao/ranking';
import { pctPositivacao, pctCobertura, ticketMedio } from '@/lib/positivacao/format';
import type { PositivacaoResumo, ClienteAPositivar } from '@/lib/positivacao/types';

export interface PositivacaoKpis {
  mes: string;
  totalEligible: number;
  positivados: number;
  pctPositivacao: number;
  ticketMedio: number;
  pctCobertura: number;
  recenciaCritica: number;
  novosPositivados: number;
  aPositivar: ClienteAPositivar[];
}

export function useMyPositivacao() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-positivacao', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<PositivacaoKpis | null> => {
      if (!user) return null;
      const { data, error } = await supabase.rpc('get_minha_positivacao');
      if (error) throw error;
      if (!data) return null;
      const r = data as unknown as PositivacaoResumo;
      return {
        mes: r.mes,
        totalEligible: r.total_eligible,
        positivados: r.positivados,
        pctPositivacao: pctPositivacao(r.positivados, r.total_eligible),
        ticketMedio: ticketMedio(r.receita_mtd, r.compradores_mtd),
        pctCobertura: pctCobertura(r.contatados_mtd, r.total_eligible),
        recenciaCritica: r.recencia_critica,
        novosPositivados: r.novos_clientes_positivados,
        aPositivar: rankAPositivar(r.a_positivar ?? []),
      };
    },
  });
}
```

> ⚠️ A RPC `get_minha_positivacao` não estará nos tipos gerados até regenerar. `supabase.rpc('get_minha_positivacao')` sem arg pode exigir `(supabase.rpc as any)` OU regenerar tipos. Preferir cast pontual no boundary (`as unknown as PositivacaoResumo`) e, se o `.rpc` reclamar do nome, `(supabase as any).rpc('get_minha_positivacao')` com comentário (a função existe pós-migration).

- [ ] **Step 2: Typecheck + commit**

```bash
heavy bun run typecheck:strict
git add src/hooks/useMyPositivacao.ts
git commit -m "feat(positivacao): hook useMyPositivacao (RPC + helpers)"
```

---

## Task 8: UI — heros + lista no FarmerCalls; rebaixar atividade

**Files:** Create `src/components/farmer/PositivacaoHero.tsx`, `src/components/farmer/ClientesAPositivarCard.tsx`; Modify `src/pages/FarmerCalls.tsx`

> Implementador lê `FarmerCalls.tsx` e `src/components/dashboard/VisitSuggestionsCard.tsx` antes (reusar o padrão visual da lista). Papel via `useMyCommercialRole`.

- [ ] **Step 1: `PositivacaoHero.tsx`** — 3 cards de KPI (variando por papel)

```tsx
// src/components/farmer/PositivacaoHero.tsx
import { Card } from '@/components/ui/card';
import type { PositivacaoKpis } from '@/hooks/useMyPositivacao';

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className="kpi-value text-2xl">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

export function PositivacaoHero({ kpis, isHunter }: { kpis: PositivacaoKpis; isHunter: boolean }) {
  const ticket = `R$ ${kpis.ticketMedio.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
  return (
    <div className="space-y-3">
      {/* Hero (3 KPIs principais por papel) */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {isHunter ? (
          <>
            <KpiCard label="Novos clientes positivados" value={String(kpis.novosPositivados)} sub="1ª compra no mês" />
            <KpiCard label="Clientes a positivar" value={String(kpis.aPositivar.length)} sub="pool sem pedido no mês" />
            <KpiCard label="Recência crítica" value={String(kpis.recenciaCritica)} sub="risco alto / atrasados" />
          </>
        ) : (
          <>
            <KpiCard label="Positivação MTD" value={`${kpis.pctPositivacao}%`} sub={`${kpis.positivados}/${kpis.totalEligible} da carteira`} />
            <KpiCard label="Clientes a positivar" value={String(kpis.aPositivar.length)} sub="sem pedido no mês" />
            <KpiCard label="Cobertura de contato" value={`${kpis.pctCobertura}%`} sub="contatados no mês" />
          </>
        )}
      </div>
      {/* Linha secundária (KPIs de apoio) */}
      <div className="grid grid-cols-2 gap-3">
        <KpiCard label="Ticket médio MTD" value={ticket} sub="receita ÷ compradores no mês" />
        {isHunter
          ? <KpiCard label="Cobertura de contato" value={`${kpis.pctCobertura}%`} sub="contatados no mês" />
          : <KpiCard label="Recência crítica" value={String(kpis.recenciaCritica)} sub="risco alto / atrasados" />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `ClientesAPositivarCard.tsx`** — lista acionável (reusa padrão do VisitSuggestionsCard)

```tsx
// src/components/farmer/ClientesAPositivarCard.tsx
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ClienteAPositivar } from '@/lib/positivacao/types';

export function ClientesAPositivarCard({ clientes }: { clientes: ClienteAPositivar[] }) {
  if (clientes.length === 0) {
    return <Card className="p-6 text-2xs text-muted-foreground">Toda a carteira elegível já comprou este mês. 🎯</Card>;
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Clientes a positivar</h2>
        <p className="text-2xs text-muted-foreground">{clientes.length} clientes da sua carteira ainda sem pedido este mês — ordenados por prioridade</p>
      </CardHeader>
      <div className="divide-y divide-border">
        {clientes.slice(0, 30).map((c) => (
          <Link key={c.customer_user_id} to={`/admin/customers/${c.customer_user_id}/360`}
            className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{c.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground flex gap-2 flex-wrap">
                {c.days_since_last_purchase != null && <span>{c.days_since_last_purchase}d sem comprar</span>}
                {(c.churn_risk ?? 0) >= 60 && <Badge variant="outline" className="text-status-error text-2xs">churn alto</Badge>}
              </div>
            </div>
            {c.revenue_potential != null && c.revenue_potential > 0 && (
              <div className="text-2xs text-muted-foreground font-tabular shrink-0">
                pot. R$ {Math.round(c.revenue_potential).toLocaleString('pt-BR')}
              </div>
            )}
          </Link>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Montar no `FarmerCalls.tsx`** — heros + lista no topo, atividade rebaixada

No `FarmerCalls.tsx`, importar e renderizar acima do conteúdo atual; mover os cards de atividade (`useMyKpis`) pra uma faixa secundária discreta abaixo:

```tsx
import { useMyPositivacao } from '@/hooks/useMyPositivacao';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';
import { PositivacaoHero } from '@/components/farmer/PositivacaoHero';
import { ClientesAPositivarCard } from '@/components/farmer/ClientesAPositivarCard';
// ...
const { data: pos } = useMyPositivacao();
const { data: commercialRole } = useMyCommercialRole();
const isHunter = commercialRole === 'hunter';
// No JSX, no topo:
{pos && (
  <div className="space-y-3 mb-4">
    <PositivacaoHero kpis={pos} isHunter={isHunter} />
    <ClientesAPositivarCard clientes={pos.aPositivar} />
  </div>
)}
{/* faixa de atividade do dia (KpisToday/useMyKpis) renderizada ABAIXO, com título "Atividade de hoje" e menor ênfase */}
```

> Manter a tela funcional sem `pos` (loading/sem carteira). Os KPIs de atividade atuais não são removidos — só rebaixados visualmente (título "Atividade de hoje", abaixo do hero).

- [ ] **Step 4: Lint + typecheck + commit**

```bash
bunx eslint src/components/farmer/PositivacaoHero.tsx src/components/farmer/ClientesAPositivarCard.tsx src/hooks/useMyPositivacao.ts src/pages/FarmerCalls.tsx
heavy bun run typecheck:strict
git add src/components/farmer/PositivacaoHero.tsx src/components/farmer/ClientesAPositivarCard.tsx src/pages/FarmerCalls.tsx
git commit -m "feat(positivacao): heros de positivação + lista 'a positivar' no FarmerCalls; rebaixa atividade"
```

---

## Task 9: Testes + build + rollout + PR

- [ ] **Step 1: Suite + typecheck verdes**

Run: `heavy bun run test && heavy bun run typecheck:strict` → esperado verde (incluindo os 3 novos arquivos de teste de positivacao).

- [ ] **Step 2: Regenerar audit de migrations**

```bash
bun run audit:migrations
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(positivacao): regenera audit de migrations"
```

- [ ] **Step 3: Push + PR**

O corpo do PR = resumo das mudanças + a seção "Step 4: Rollout coordenado" abaixo, verbatim (com ⚠️ ATENÇÃO: migration manual + deploy de 2 functions + cron), no mesmo formato da PR #263 do Sub-PR B. Montar via heredoc:

```bash
git push -u origin feat/carteira-positivacao-kpis
gh pr create --base main --title "feat(carteira): Sub-PR D — positivação & KPIs (Fase 4 v1)" --body "$(cat <<'EOF'
## Sub-PR D — Positivação & KPIs (Fase 4 v1)
[resumo: RPC get_minha_positivacao + order_date_kpi + snapshot/cron + heros no FarmerCalls]
## ⚠️ Rollout manual (Lovable) — ver passos
[colar os passos 1-6 do Step 4 abaixo]
## Test plan
- [x] bun run test (helpers positivacao TDD) + typecheck:strict
- [ ] rollout aplicado + RPC validada (Regina) + smoke test
EOF
)"
```

- [ ] **Step 4: Rollout coordenado (manual no Lovable, conduzir bloco-a-bloco)**

1. 🟣 SQL Editor: **BLOCO A** = `supabase/migrations/20260525120000_positivacao_kpis.sql` → esperado `col=1, snap=1, rpc=1`.
2. Chat Lovable: deploy (EDIT) de `omie-vendas-sync` + (CREATE) `carteira-positivacao-snapshot`.
3. 🟣 SQL Editor: validar a RPC com um dono real:
```sql
SELECT public.get_minha_positivacao();  -- rodar autenticado como a Regina, OU testar via app
```
4. Chat Lovable: invocar `carteira-positivacao-snapshot` com `{"mes":"<mês fechado>"}` p/ 1º snapshot (opcional) + confirmar idempotência.
5. 🟣 SQL Editor: agendar cron mensal (padrão vault):
```sql
SELECT cron.schedule('carteira-positivacao-snapshot-mensal', '0 8 1 * *',
  $$ SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-positivacao-snapshot',
    headers := jsonb_build_object('x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1))
  ); $$);
```
6. Smoke test no app: Farmer (Regina/Tati) vê Positivação MTD + lista; Hunter (Lucas) vê os heros de Hunter.

---

## Notas de risco
- **Backfill da data:** pedidos antigos sem payload → `order_date_kpi = created_at` (previsão). Mês corrente fica correto conforme re-syncs gravam `dInc`. Documentado.
- **Tipos da RPC:** não entram no `types.ts` gerado automaticamente; usar cast no boundary do hook (não re-adicionar manualmente ao types.ts — lição §10).
- **Volume:** RPC é server-side; nunca puxar a carteira pro front. A lista `a_positivar` é capada em 200.
- **Coordenação:** antes de promover arquivos novos pro `tsconfig.strict.json`, ler `docs/strict-migration-lanes.md` (não obrigatório nesta PR; os novos arquivos passam baseline + strict se importados por arquivos strict).
