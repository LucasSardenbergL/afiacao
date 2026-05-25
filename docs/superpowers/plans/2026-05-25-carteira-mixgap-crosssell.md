# Mix/Gap de cross-sell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Mostrar ao vendedor quais clientes da carteira dele estão sem uma família que clientes parecidos compram (oportunidade de cross-sell pra ligação).

**Architecture:** RPC `get_meu_mixgap()` `SECURITY DEFINER` (escopada à carteira via `auth.uid()`, espelha `get_minha_positivacao`) é a dona da verdade: unnest de `farmer_association_rules` (pisos altos) → consequent products → `omie_products.familia`, excluindo famílias já compradas (12m), 1 gap/cliente. Helper puro TDD só rankeia/formata o "por quê". UI = card no `FarmerCalls`.

**Tech Stack:** Supabase Postgres (migration manual Lovable + RPC), React + @tanstack/react-query + Vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-carteira-mixgap-crosssell-design.md`.
**Pré-requisito:** programa Carteira-Omie (A+B+D) em prod. Branch `feat/carteira-mixgap` (de `main`).

---

## Pré-requisitos operacionais
- DB só via Lovable SQL Editor. Edge: nenhuma (só RPC). `bun run test` (vitest) canônico; `heavy` antes de test/typecheck.
- Merge pelo CI (sem `--admin` de rotina; ver CLAUDE.md §10).

## File Structure

| Arquivo | Mudança |
|---|---|
| `src/lib/mixgap/types.ts` (criar) | `GapCliente`, `MixGapResumo`. |
| `src/lib/mixgap/format.ts` + `__tests__/format.test.ts` (criar) | `buildPorQue(gap)` + `rankGaps(gaps)` — puros, TDD. |
| `supabase/migrations/20260525190000_mixgap_rpc.sql` (criar) | RPC `get_meu_mixgap()`. |
| `src/hooks/useMyMixGap.ts` (criar) | chama a RPC + helper. |
| `src/components/farmer/MixGapCard.tsx` (criar) | card KPI + lista (reusa visual do `ClientesAPositivarCard`). |
| `src/pages/FarmerCalls.tsx` (modificar) | renderiza `<MixGapCard />` na seção de carteira. |

---

## Task 1: Tipos + helper de formatação/ranking (TDD)

**Files:** Create `src/lib/mixgap/types.ts`, `src/lib/mixgap/format.ts`, `src/lib/mixgap/__tests__/format.test.ts`

- [ ] **Step 1: Tipos**

```ts
// src/lib/mixgap/types.ts
export interface GapCliente {
  customer_user_id: string;
  nome: string | null;
  familia_faltante: string;
  confidence: number;
  lift: number;
  evidence_count: number;
}

export interface MixGapResumo {
  total_com_gap: number;
  lista: GapCliente[];
}
```

- [ ] **Step 2: Teste que falha**

```ts
// src/lib/mixgap/__tests__/format.test.ts
import { describe, it, expect } from 'vitest';
import { buildPorQue, rankGaps } from '../format';
import type { GapCliente } from '../types';

const g = (over: Partial<GapCliente>): GapCliente => ({
  customer_user_id: 'x', nome: null, familia_faltante: 'Vernizes',
  confidence: 0.3, lift: 2, evidence_count: 1, ...over,
});

describe('buildPorQue', () => {
  it('monta texto concreto com família, confiança % e lift', () => {
    const txt = buildPorQue(g({ familia_faltante: 'Vernizes', confidence: 0.32, lift: 2.4, evidence_count: 3 }));
    expect(txt).toContain('Vernizes');
    expect(txt).toContain('32%');
    expect(txt).toContain('2.4');
    expect(txt).toContain('3');
  });
});

describe('rankGaps', () => {
  it('ordena por confidence*lift desc, desempate por evidence_count; não muta', () => {
    const input = [
      g({ customer_user_id: 'a', confidence: 0.2, lift: 2, evidence_count: 1 }),  // 0.4
      g({ customer_user_id: 'b', confidence: 0.5, lift: 2, evidence_count: 1 }),  // 1.0
      g({ customer_user_id: 'c', confidence: 0.5, lift: 2, evidence_count: 9 }),  // 1.0, mais evidência
    ];
    const out = rankGaps(input);
    expect(out.map((x) => x.customer_user_id)).toEqual(['c', 'b', 'a']);
    expect(input[0].customer_user_id).toBe('a'); // não mutou
  });
});
```

- [ ] **Step 3: Rodar e ver falhar** — `heavy bun run test src/lib/mixgap/__tests__/format.test.ts` → FAIL.

- [ ] **Step 4: Implementar**

```ts
// src/lib/mixgap/format.ts
import type { GapCliente } from './types';

/** Texto concreto do "por quê" do gap. */
export function buildPorQue(g: GapCliente): string {
  const pct = Math.round(g.confidence * 100);
  const lift = Math.round(g.lift * 10) / 10;
  return `Clientes com padrão de compra parecido também compram ${g.familia_faltante} — confiança ${pct}%, lift ${lift}, ${g.evidence_count} evidência(s).`;
}

/** Ordena gaps por força da evidência (confidence×lift), desempate por evidence_count. Não muta. */
export function rankGaps(gaps: GapCliente[]): GapCliente[] {
  return [...gaps].sort((a, b) => {
    const fa = a.confidence * a.lift;
    const fb = b.confidence * b.lift;
    if (fb !== fa) return fb - fa;
    return b.evidence_count - a.evidence_count;
  });
}
```

- [ ] **Step 5: Rodar e ver passar** — `heavy bun run test src/lib/mixgap/__tests__/format.test.ts` → 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mixgap/
git commit -m "feat(mixgap): tipos + helper buildPorQue/rankGaps + testes TDD"
```

---

## Task 2: Migration — RPC get_meu_mixgap

**Files:** Create `supabase/migrations/20260525190000_mixgap_rpc.sql`

> RPC valida via SQL. IDs das regras = `omie_products.id` (uuid texto); `order_items.product_id` = mesmo uuid (fallback `omie_codigo_produto`). Categoria = `omie_products.familia`.

- [ ] **Step 1: Escrever a migration**

```sql
-- 20260525190000_mixgap_rpc.sql
-- Mix/Gap de cross-sell: famílias faltantes na carteira do dono, via regras de associação.
CREATE OR REPLACE FUNCTION public.get_meu_mixgap()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT (has_role(uid, 'master'::app_role) OR has_role(uid, 'employee'::app_role)) THEN
    RETURN NULL;
  END IF;

  WITH eleg AS (
    SELECT customer_user_id FROM public.carteira_assignments
    WHERE owner_user_id = uid AND eligible = true
  ),
  compras AS (  -- produto+família comprados nos últimos 12m pelos elegíveis
    SELECT DISTINCT oi.customer_user_id, op.id::text AS pid, op.familia
    FROM public.order_items oi
    JOIN eleg e ON e.customer_user_id = oi.customer_user_id
    JOIN public.omie_products op
      ON (oi.product_id = op.id
          OR (oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto))
    WHERE oi.created_at >= now() - interval '12 months'
      AND op.familia IS NOT NULL
  ),
  cliente_produtos AS (
    SELECT customer_user_id, array_agg(DISTINCT pid) AS prods
    FROM compras GROUP BY customer_user_id
  ),
  cliente_familias AS (
    SELECT customer_user_id, array_agg(DISTINCT familia) AS fams
    FROM compras GROUP BY customer_user_id
  ),
  regras AS (  -- pisos anti-ruído (acima do engine: 0.05/1.0)
    SELECT antecedent_product_ids, consequent_product_ids, confidence, lift
    FROM public.farmer_association_rules
    WHERE confidence >= 0.15 AND lift >= 1.5 AND sample_size >= 30
  ),
  matches AS (  -- cliente comprou TODOS os antecedentes da regra
    SELECT cp.customer_user_id, r.consequent_product_ids, r.confidence, r.lift
    FROM cliente_produtos cp
    JOIN regras r ON r.antecedent_product_ids <@ cp.prods
  ),
  gaps AS (  -- família-consequente que o cliente AINDA não compra
    SELECT m.customer_user_id, op.familia AS familia_faltante, m.confidence, m.lift
    FROM matches m
    CROSS JOIN LATERAL unnest(m.consequent_product_ids) AS cons(pid)
    JOIN public.omie_products op ON op.id::text = cons.pid
    JOIN cliente_familias cf ON cf.customer_user_id = m.customer_user_id
    WHERE op.familia IS NOT NULL
      AND NOT (op.familia = ANY (cf.fams))
  ),
  gap_agg AS (
    SELECT customer_user_id, familia_faltante,
           max(confidence) AS confidence, max(lift) AS lift, count(*) AS evidence_count
    FROM gaps
    GROUP BY customer_user_id, familia_faltante
  ),
  top1 AS (  -- 1 gap por cliente (maior confidence×lift)
    SELECT DISTINCT ON (customer_user_id)
      customer_user_id, familia_faltante, confidence, lift, evidence_count
    FROM gap_agg
    ORDER BY customer_user_id, (confidence * lift) DESC, evidence_count DESC
  )
  SELECT jsonb_build_object(
    'total_com_gap', (SELECT count(*) FROM top1),
    'lista', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_user_id', t.customer_user_id,
        'nome', COALESCE(p.razao_social, p.name),
        'familia_faltante', t.familia_faltante,
        'confidence', t.confidence,
        'lift', t.lift,
        'evidence_count', t.evidence_count
      ) ORDER BY (t.confidence * t.lift) DESC, t.evidence_count DESC)
      FROM (SELECT * FROM top1 ORDER BY (confidence * lift) DESC, evidence_count DESC LIMIT 100) t
      LEFT JOIN public.profiles p ON p.user_id = t.customer_user_id
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_meu_mixgap() TO authenticated;

SELECT 'BLOCO MIXGAP OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'get_meu_mixgap') AS rpc;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260525190000_mixgap_rpc.sql
git commit -m "feat(mixgap): migration RPC get_meu_mixgap (regras→familia, gap por cliente)"
```
Entregar como BLOCO no rollout; esperado `rpc=1`.

---

## Task 3: Hook useMyMixGap

**Files:** Create `src/hooks/useMyMixGap.ts`

- [ ] **Step 1: Implementar**

```ts
// src/hooks/useMyMixGap.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { rankGaps } from '@/lib/mixgap/format';
import type { MixGapResumo, GapCliente } from '@/lib/mixgap/types';

export interface MixGap {
  totalComGap: number;
  lista: GapCliente[];
}

export function useMyMixGap() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-mixgap', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<MixGap | null> => {
      if (!user) return null;
      // RPC fora dos tipos gerados — cast no boundary (preserva `this` do client).
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('get_meu_mixgap');
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as MixGapResumo;
      return { totalComGap: r.total_com_gap, lista: rankGaps(r.lista ?? []) };
    },
  });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
heavy bun run typecheck:strict
git add src/hooks/useMyMixGap.ts
git commit -m "feat(mixgap): hook useMyMixGap (RPC + rankGaps)"
```

---

## Task 4: UI — MixGapCard no FarmerCalls

**Files:** Create `src/components/farmer/MixGapCard.tsx`; Modify `src/pages/FarmerCalls.tsx`

> Implementador lê `src/components/farmer/ClientesAPositivarCard.tsx` antes (reusar o padrão visual da lista).

- [ ] **Step 1: `MixGapCard.tsx`**

```tsx
// src/components/farmer/MixGapCard.tsx
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { buildPorQue } from '@/lib/mixgap/format';

export function MixGapCard() {
  const { data } = useMyMixGap();
  if (!data || data.totalComGap === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Oportunidades de cross-sell</h2>
        <p className="text-2xs text-muted-foreground">
          {data.totalComGap} clientes da sua carteira sem uma família que clientes parecidos compram
        </p>
      </CardHeader>
      <div className="divide-y divide-border">
        {data.lista.slice(0, 20).map((g) => (
          <Link key={g.customer_user_id} to={`/admin/customers/${g.customer_user_id}/360`}
            className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{g.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground">{buildPorQue(g)}</div>
            </div>
            <Badge variant="outline" className="text-status-info text-2xs shrink-0">{g.familia_faltante}</Badge>
          </Link>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Montar no `FarmerCalls.tsx`**

Importar e renderizar dentro do bloco de positivação (`{positivacao && (...)}` — logo após `<ClientesAPositivarCard />`):

```tsx
import { MixGapCard } from '@/components/farmer/MixGapCard';
// ...
// no JSX, dentro da <div className="space-y-3 mb-4"> da positivação, após ClientesAPositivarCard:
<MixGapCard />
```

- [ ] **Step 3: Lint + typecheck + commit**

```bash
bunx eslint src/components/farmer/MixGapCard.tsx src/hooks/useMyMixGap.ts src/pages/FarmerCalls.tsx
heavy bun run typecheck:strict
git add src/components/farmer/MixGapCard.tsx src/pages/FarmerCalls.tsx
git commit -m "feat(mixgap): MixGapCard de cross-sell no FarmerCalls"
```

---

## Task 5: Testes + audit + PR + rollout

- [ ] **Step 1: Suite + typecheck** — `heavy bun run test && heavy bun run typecheck:strict` → verde.
- [ ] **Step 2: Audit** — `bun run audit:migrations` + commit (`chore(mixgap): regenera audit`).
- [ ] **Step 3: Push + PR** — `git push -u origin feat/carteira-mixgap` + `gh pr create --base main` (corpo: resumo + rollout abaixo). Mergear pelo CI (auto-merge, sem `--admin`).
- [ ] **Step 4: Rollout (Lovable):**
  1. 🟣 SQL Editor: BLOCO A = `20260525190000_mixgap_rpc.sql` → `rpc=1`.
  2. 🟣 SQL Editor (validar lógica com a Regina): rodar a CTE da RPC com `owner_user_id = '700657a1-d75d-4c72-99b1-0a0f2065fa29'` hardcoded e ver `total_com_gap` + amostra da lista (faz sentido? famílias plausíveis?).
  3. App: FarmerCalls do vendedor mostra "Oportunidades de cross-sell".

---

## Notas de risco
- **`omie_products.familia` com buracos** → produtos sem família não geram gap (degradação silenciosa aceitável).
- **`<@` containment**: `antecedent_product_ids <@ prods` exige que o cliente tenha comprado TODOS os antecedentes. Regras com antecedente de 1 produto (a maioria) casam fácil; antecedentes grandes raramente casam (ok — menos ruído).
- **RPC retorna `[]` se as regras estiverem vazias** (`farmer_association_rules` precisa ter sido populada pelo bundle engine). Se `total_com_gap=0` no rollout, checar se há regras com os pisos altos (talvez baixar pra 0.10/1.3 se a base for pequena — decisão no rollout, medir primeiro).
- **Tipos da RPC**: não entram no `types.ts` gerado; cast no boundary do hook (não re-adicionar ao types.ts — lição §10).
