# Mix/Gap — loop de conversão · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o vendedor marcar cada oportunidade de cross-sell (cliente × família) como ofertado/convertido/recusado, suprimindo o que não deve reaparecer (convertido pra sempre, recusado por 90d) e capturando o sinal de conversão.

**Architecture:** 1 migration (tabela `farmer_mixgap_feedback` + RLS + RPC `mark_mixgap_feedback` com `seller=auth.uid()` + `CREATE OR REPLACE` do internal compartilhado `_carteira_mixgap_for_owner` pra filtrar suprimidos e devolver `feedback_status`). Client: helper puro de optimistic-update (TDD), hook `useMarkMixGapFeedback` (optimistic + rollback), menu `⋯` por linha no `MixGapCard` (desabilitado na impersonação).

**Tech Stack:** Supabase Postgres (RPC SECURITY DEFINER, migration manual via Lovable SQL Editor), React + @tanstack/react-query (optimistic mutation), shadcn `DropdownMenu`, Vitest. Sem edge function.

**Spec:** `docs/superpowers/specs/2026-05-26-mixgap-loop-conversao-design.md`

---

## File Structure

- Create `supabase/migrations/20260526230000_mixgap_feedback.sql` — tabela + RLS + RPC `mark_mixgap_feedback` + `CREATE OR REPLACE _carteira_mixgap_for_owner`.
- Modify `src/lib/mixgap/types.ts` — `GapCliente.feedback_status`.
- Create `src/lib/mixgap/feedback.ts` (+ `__tests__/feedback.test.ts`) — helper puro `applyFeedbackToMixGap`.
- Create `src/hooks/useMarkMixGapFeedback.ts` — mutation optimistic.
- Modify `src/components/farmer/MixGapCard.tsx` — menu `⋯` + selo + gate de impersonação.

---

## Task 1: Migration — tabela + RPC + internal com supressão

**Files:** Create `supabase/migrations/20260526230000_mixgap_feedback.sql`

- [ ] **Step 1: Escrever a migration.** Conteúdo completo:

```sql
-- 20260526230000_mixgap_feedback.sql
-- Loop de conversão do Mix/Gap: feedback do vendedor (ofertado/convertido/recusado) + supressão.

CREATE TABLE IF NOT EXISTS public.farmer_mixgap_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_user_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  familia text NOT NULL,
  status text NOT NULL CHECK (status IN ('ofertado','convertido','recusado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_user_id, customer_user_id, familia)
);
ALTER TABLE public.farmer_mixgap_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mixgap feedback select" ON public.farmer_mixgap_feedback;
CREATE POLICY "mixgap feedback select" ON public.farmer_mixgap_feedback
  FOR SELECT USING (seller_user_id = auth.uid() OR has_role(auth.uid(),'master'::app_role));
DROP POLICY IF EXISTS "mixgap feedback iud" ON public.farmer_mixgap_feedback;
CREATE POLICY "mixgap feedback iud" ON public.farmer_mixgap_feedback
  FOR ALL USING (seller_user_id = auth.uid()) WITH CHECK (seller_user_id = auth.uid());

-- RPC: marca (upsert). seller = auth.uid() SEMPRE (nunca client-provided).
CREATE OR REPLACE FUNCTION public.mark_mixgap_feedback(p_customer uuid, p_familia text, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_status NOT IN ('ofertado','convertido','recusado') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;
  IF p_customer IS NULL OR p_familia IS NULL THEN RAISE EXCEPTION 'customer e familia required'; END IF;
  INSERT INTO public.farmer_mixgap_feedback (seller_user_id, customer_user_id, familia, status)
  VALUES (auth.uid(), p_customer, p_familia, p_status)
  ON CONFLICT (seller_user_id, customer_user_id, familia)
  DO UPDATE SET status = EXCLUDED.status, updated_at = now();
END; $$;
GRANT EXECUTE ON FUNCTION public.mark_mixgap_feedback(uuid, text, text) TO authenticated;

-- Internal do Mix/Gap (compartilhado por get_meu_mixgap e get_meu_mixgap_for):
-- + CTE feedback (do dono), + gap_visivel (exclui convertido + recusado<90d), + feedback_status no retorno.
-- Corpo idêntico ao de 20260525210000_viewas_rpcs_for.sql exceto essas adições.
CREATE OR REPLACE FUNCTION public._carteira_mixgap_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := p_owner;
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  WITH eleg AS (
    SELECT customer_user_id FROM public.carteira_assignments
    WHERE owner_user_id = uid AND eligible = true
  ),
  compras AS (
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
    SELECT customer_user_id, array_agg(DISTINCT pid) AS prods FROM compras GROUP BY customer_user_id
  ),
  cliente_familias AS (
    SELECT customer_user_id, array_agg(DISTINCT familia) AS fams FROM compras GROUP BY customer_user_id
  ),
  regras AS (
    SELECT antecedent_product_ids, consequent_product_ids, confidence, lift
    FROM public.farmer_association_rules
    WHERE confidence >= 0.15 AND lift >= 1.5 AND sample_size >= 30
  ),
  matches AS (
    SELECT cp.customer_user_id, r.consequent_product_ids, r.confidence, r.lift
    FROM cliente_produtos cp JOIN regras r ON r.antecedent_product_ids <@ cp.prods
  ),
  gaps AS (
    SELECT m.customer_user_id, op.familia AS familia_faltante, m.confidence, m.lift
    FROM matches m
    CROSS JOIN LATERAL unnest(m.consequent_product_ids) AS cons(pid)
    JOIN public.omie_products op ON op.id::text = cons.pid
    JOIN cliente_familias cf ON cf.customer_user_id = m.customer_user_id
    WHERE op.familia IS NOT NULL AND NOT (op.familia = ANY (cf.fams))
  ),
  feedback AS (
    SELECT customer_user_id, familia, status, updated_at
    FROM public.farmer_mixgap_feedback
    WHERE seller_user_id = uid
  ),
  gap_agg AS (
    SELECT customer_user_id, familia_faltante,
           max(confidence) AS confidence, max(lift) AS lift, count(*) AS evidence_count
    FROM gaps GROUP BY customer_user_id, familia_faltante
  ),
  gap_visivel AS (
    SELECT ga.* FROM gap_agg ga
    WHERE NOT EXISTS (
      SELECT 1 FROM feedback f
      WHERE f.customer_user_id = ga.customer_user_id AND f.familia = ga.familia_faltante
        AND (f.status = 'convertido' OR (f.status = 'recusado' AND f.updated_at > now() - interval '90 days'))
    )
  ),
  top1 AS (
    SELECT DISTINCT ON (customer_user_id)
      customer_user_id, familia_faltante, confidence, lift, evidence_count
    FROM gap_visivel ORDER BY customer_user_id, (confidence * lift) DESC, evidence_count DESC
  )
  SELECT jsonb_build_object(
    'total_com_gap', (SELECT count(*) FROM top1),
    'lista', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_user_id', t.customer_user_id,
        'nome', COALESCE(p.razao_social, p.name),
        'familia_faltante', t.familia_faltante,
        'confidence', t.confidence, 'lift', t.lift, 'evidence_count', t.evidence_count,
        'feedback_status', (SELECT f.status FROM feedback f
                            WHERE f.customer_user_id = t.customer_user_id AND f.familia = t.familia_faltante)
      ) ORDER BY (t.confidence * t.lift) DESC, t.evidence_count DESC)
      FROM (SELECT * FROM top1 ORDER BY (confidence * lift) DESC, evidence_count DESC LIMIT 100) t
      LEFT JOIN public.profiles p ON p.user_id = t.customer_user_id
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

SELECT 'BLOCO MIXGAP-FEEDBACK OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_name='farmer_mixgap_feedback') AS tbl,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('mark_mixgap_feedback','_carteira_mixgap_for_owner')) AS fns;
```

> ⚠️ O corpo do internal (CTEs eleg→top1) foi copiado de `supabase/migrations/20260525210000_viewas_rpcs_for.sql`. Antes de entregar, **diffar contra o arquivo atual** desse internal pra garantir que a base não mudou (só as adições `feedback`/`gap_visivel`/`feedback_status` devem diferir). As RPCs `get_meu_mixgap`/`get_meu_mixgap_for` **não** mudam (continuam delegando ao internal).

- [ ] **Step 2: Entregar ao founder (BLOCO MIXGAP-FEEDBACK).** Esperado `tbl=1, fns=2`. Validar: marcar um gap de teste via `SELECT mark_mixgap_feedback('<cliente>','<familia>','convertido')` como um vendedor e conferir que sumiu de `get_meu_mixgap` dele.

- [ ] **Step 3: Commit.**
```bash
git add supabase/migrations/20260526230000_mixgap_feedback.sql
git commit -m "feat(mixgap): tabela+RPC de feedback + supressão no internal _carteira_mixgap_for_owner"
```

---

## Task 2: Type `feedback_status` em GapCliente

**Files:** Modify `src/lib/mixgap/types.ts`

- [ ] **Step 1: Editar.** Adicionar o campo ao `GapCliente`:
```ts
export interface GapCliente {
  customer_user_id: string;
  nome: string | null;
  familia_faltante: string;
  confidence: number;
  lift: number;
  evidence_count: number;
  feedback_status?: 'ofertado' | null;
}
```

- [ ] **Step 2: Typecheck.** `heavy bun run typecheck:strict` → 0 (o campo é opcional; `rankGaps` faz spread, preserva). 

- [ ] **Step 3: Commit.**
```bash
git add src/lib/mixgap/types.ts
git commit -m "feat(mixgap): GapCliente.feedback_status"
```

---

## Task 3: Helper puro `applyFeedbackToMixGap` (TDD)

**Files:** Create `src/lib/mixgap/feedback.ts` + `src/lib/mixgap/__tests__/feedback.test.ts`

- [ ] **Step 1: Escrever o teste (falha).**
```ts
// src/lib/mixgap/__tests__/feedback.test.ts
import { describe, it, expect } from 'vitest';
import { applyFeedbackToMixGap } from '../feedback';
import type { MixGap } from '@/hooks/useMyMixGap';

const base: MixGap = {
  totalComGap: 2,
  lista: [
    { customer_user_id: 'c1', nome: 'A', familia_faltante: 'PU', confidence: 0.5, lift: 8, evidence_count: 1 },
    { customer_user_id: 'c2', nome: 'B', familia_faltante: 'Thinner', confidence: 0.4, lift: 6, evidence_count: 2 },
  ],
};

describe('applyFeedbackToMixGap', () => {
  it('ofertado: seta selo na linha, mantém total', () => {
    const r = applyFeedbackToMixGap(base, 'c1', 'PU', 'ofertado');
    expect(r.totalComGap).toBe(2);
    expect(r.lista.find((g) => g.customer_user_id === 'c1')?.feedback_status).toBe('ofertado');
  });
  it('convertido: remove a linha e decrementa o total', () => {
    const r = applyFeedbackToMixGap(base, 'c1', 'PU', 'convertido');
    expect(r.totalComGap).toBe(1);
    expect(r.lista.some((g) => g.customer_user_id === 'c1')).toBe(false);
  });
  it('recusado: remove a linha e decrementa o total', () => {
    const r = applyFeedbackToMixGap(base, 'c2', 'Thinner', 'recusado');
    expect(r.totalComGap).toBe(1);
    expect(r.lista.some((g) => g.customer_user_id === 'c2')).toBe(false);
  });
  it('não muta o original', () => {
    applyFeedbackToMixGap(base, 'c1', 'PU', 'convertido');
    expect(base.lista).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Rodar (falha).** `heavy bun run test src/lib/mixgap` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar.**
```ts
// src/lib/mixgap/feedback.ts
import type { MixGap } from '@/hooks/useMyMixGap';

export type MixGapStatus = 'ofertado' | 'convertido' | 'recusado';

/** Aplica o feedback ao cache do Mix/Gap (puro, não muta). ofertado → selo;
 * convertido/recusado → remove a linha e decrementa o total. */
export function applyFeedbackToMixGap(
  mix: MixGap,
  customerUserId: string,
  _familia: string,
  status: MixGapStatus,
): MixGap {
  if (status === 'ofertado') {
    return {
      ...mix,
      lista: mix.lista.map((g) =>
        g.customer_user_id === customerUserId ? { ...g, feedback_status: 'ofertado' } : g,
      ),
    };
  }
  const lista = mix.lista.filter((g) => g.customer_user_id !== customerUserId);
  return { totalComGap: Math.max(0, mix.totalComGap - (mix.lista.length - lista.length)), lista };
}
```
> `_familia` fica no contrato (a chave servidor é cliente×família) mas a lista é 1-gap-por-cliente, então o match por `customer_user_id` basta. Prefixo `_` evita lint de unused.

- [ ] **Step 4: Rodar (passa).** `heavy bun run test src/lib/mixgap` → PASS (4 novos + os 2 existentes do mixgap).

- [ ] **Step 5: Commit.**
```bash
git add src/lib/mixgap/feedback.ts src/lib/mixgap/__tests__/feedback.test.ts
git commit -m "feat(mixgap): helper puro applyFeedbackToMixGap (TDD)"
```

---

## Task 4: Hook `useMarkMixGapFeedback` (optimistic)

**Files:** Create `src/hooks/useMarkMixGapFeedback.ts`

- [ ] **Step 1: Implementar.**
```ts
// src/hooks/useMarkMixGapFeedback.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { applyFeedbackToMixGap, type MixGapStatus } from '@/lib/mixgap/feedback';
import { track } from '@/lib/analytics';
import type { MixGap } from '@/hooks/useMyMixGap';

interface MarkArgs { customerUserId: string; familia: string; status: MixGapStatus; }

/** Marca um gap como ofertado/convertido/recusado. Optimistic sobre ['my-mixgap', effectiveUserId]. */
export function useMarkMixGapFeedback() {
  const qc = useQueryClient();
  const { effectiveUserId } = useImpersonation();
  const key = ['my-mixgap', effectiveUserId];
  return useMutation({
    mutationFn: async ({ customerUserId, familia, status }: MarkArgs) => {
      const client = supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
      };
      const { error } = await client.rpc('mark_mixgap_feedback', {
        p_customer: customerUserId, p_familia: familia, p_status: status,
      });
      if (error) throw new Error(error.message);
    },
    onMutate: async ({ customerUserId, familia, status }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MixGap | null>(key);
      if (prev) qc.setQueryData<MixGap>(key, applyFeedbackToMixGap(prev, customerUserId, familia, status));
      track('carteira.mixgap_feedback', { status });
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: key }); },
  });
}
```
> Não desestrutura `.rpc` (chama em `client.rpc(...)` — preserva `this`). Não referencia `effectiveUserId` em payload de WRITE (só na queryKey de leitura/cache) → passa no guard `no-write-leak`.

- [ ] **Step 2: Typecheck.** `heavy bun run typecheck:strict` → 0.

- [ ] **Step 3: Commit.**
```bash
git add src/hooks/useMarkMixGapFeedback.ts
git commit -m "feat(mixgap): hook useMarkMixGapFeedback (optimistic + rollback)"
```

---

## Task 5: UI — menu `⋯` no MixGapCard + selo + gate de impersonação

**Files:** Modify `src/components/farmer/MixGapCard.tsx`

- [ ] **Step 1: Verificar exports do DropdownMenu.** `grep -E "export" src/components/ui/dropdown-menu.tsx` — confirmar `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` (shadcn padrão). Usar os nomes reais.

- [ ] **Step 2: Reescrever o `MixGapCard`** (a linha deixa de ser um `<Link>` inteiro; o Link vira só a parte do nome, e o menu é irmão pra não disparar navegação):
```tsx
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MoreVertical } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { useMarkMixGapFeedback } from '@/hooks/useMarkMixGapFeedback';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { buildPorQue } from '@/lib/mixgap/format';
import { track } from '@/lib/analytics';

export function MixGapCard() {
  const { data } = useMyMixGap();
  const { mutate: markFeedback } = useMarkMixGapFeedback();
  const { isImpersonating } = useImpersonation();
  const totalComGap = data?.totalComGap ?? 0;
  const tracked = useRef(false);
  useEffect(() => {
    if (totalComGap > 0 && !tracked.current) {
      tracked.current = true;
      track('carteira.mixgap_visto', { total_com_gap: totalComGap });
    }
  }, [totalComGap]);
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
          <div key={g.customer_user_id} className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30">
            <Link
              to={`/admin/customers/${g.customer_user_id}/360`}
              onClick={() => track('carteira.mixgap_cliente_aberto', { familia: g.familia_faltante })}
              className="min-w-0 flex-1"
            >
              <div className="text-sm font-medium truncate">{g.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground">{buildPorQue(g)}</div>
            </Link>
            <div className="flex items-center gap-2 shrink-0">
              {g.feedback_status === 'ofertado' && (
                <Badge variant="outline" className="text-status-warning text-2xs">ofertado</Badge>
              )}
              <Badge variant="outline" className="text-status-info text-2xs">{g.familia_faltante}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={isImpersonating}
                  title={isImpersonating ? 'Indisponível em modo Ver como' : 'Marcar oportunidade'}
                  className="p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <MoreVertical className="w-4 h-4 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'ofertado' })}>
                    Ofertado
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'convertido' })}>
                    Convertido
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'recusado' })}>
                    Recusado
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Typecheck + build + testes.** `heavy bun run typecheck:strict` → 0; `heavy bun run test src/lib/mixgap` → PASS; `heavy bun run build` → OK.

- [ ] **Step 4: Commit.**
```bash
git add src/components/farmer/MixGapCard.tsx
git commit -m "feat(mixgap): menu de feedback (ofertado/convertido/recusado) + selo + gate de impersonação"
```

---

## Task 6: Codex review + validação + PR + rollout

- [ ] **Step 1: Codex review.** `codex exec` (read-only) na migration + hook: o `seller_user_id` é sempre `auth.uid()`? a supressão escapa o dono? `effectiveUserId` não vaza pra write? o internal preserva contrato sem feedback? Corrigir achados.

- [ ] **Step 2: Suite completa.** `heavy bun run test` (verde) · `heavy bun run typecheck:strict` (0) · `bun lint` (0 errors) · `heavy bun run build`.

- [ ] **Step 3: Regenerar audit.** `bun run audit:migrations` → `git add docs/migrations-audit.md scripts/audit-custom-migrations.sql`.

- [ ] **Step 4: PR.** `gh pr create` com corpo: o que é, o BLOCO SQL inline (MIXGAP-FEEDBACK), "**ATENÇÃO: migration manual**", test plan. `gh pr merge --squash --auto`.

- [ ] **Step 5: Rollout (founder).** Entregar o BLOCO inline → `tbl=1, fns=2` → marcar um gap de teste e confirmar supressão/selo. Deploy do front pelo Lovable (sem edge function).

---

## Self-Review (preenchido)

**Spec coverage:** ✅ tabela+RLS+RPC (T1) · supressão convertido/recusado-90d no internal (T1) · feedback_status (T1+T2) · helper optimistic puro (T3) · hook mutation (T4) · UI menu+selo+gate impersonação (T5) · Codex+rollout (T6).

**Placeholders:** nenhum. O internal em T1 é copiado verbatim de `20260525210000` + 3 adições (com nota pra diffar antes de entregar).

**Type consistency:** `MixGapStatus` definido em `feedback.ts` (T3), reusado no hook (T4). `applyFeedbackToMixGap(mix, customerUserId, familia, status)` — mesma assinatura em T3 e T4. `feedback_status?: 'ofertado' | null` (T2) consumido na UI (T5). `MarkArgs {customerUserId, familia, status}` consistente T4↔T5. queryKey `['my-mixgap', effectiveUserId]` igual ao `useMyMixGap` (T4).

**Riscos:** o `CREATE OR REPLACE` do internal (T1) é o ponto sensível — diffar contra o arquivo atual antes de entregar; sem feedback, `gap_visivel`=`gap_agg` e `feedback_status`=null → contrato preservado.
