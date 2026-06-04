# Bridge de Picking da Oben — plano de implementação

> **Para workers agênticos:** SUB-SKILL: superpowers:subagent-driven-development. Steps com checkbox.

**Goal:** ligar pedido de venda Oben → task de separação (nascimento manual idempotente) → confirmação fecha a task-pai, sem tocar nos syncs do Omie.

**Arquitetura:** helper puro TDD (oráculo) espelhado em 3 RPCs `SECURITY DEFINER`; frontend manual ("Enviar para separação") + confirmPickItem reescrito p/ RPC atômica única.

**Spec:** `docs/superpowers/specs/2026-06-04-picking-bridge-design.md` (lê antes).

**Tech:** React 18 + TS strict + Supabase (plpgsql) + vitest. `account` lowercase.

---

## Task 1: helper puro `bridge-helpers.ts` (TDD)

**Files:**
- Create: `src/lib/picking/bridge-helpers.ts`
- Test: `src/lib/picking/bridge-helpers.test.ts`

- [ ] **Step 1 — teste falhando** (`bridge-helpers.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { mapItemsToPickingRows, deriveParentStatus } from './bridge-helpers';

describe('mapItemsToPickingRows', () => {
  it('mapeia itens inteiros', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 12, descricao: 'X', quantidade: 3 }]);
    expect(r.rows).toEqual([{ omie_codigo_produto: 12, product_descricao: 'X', quantidade: 3 }]);
    expect(r.fractionalNotes).toHaveLength(0);
    expect(r.badCount).toBe(0);
  });
  it('ceil + nota em fracionário', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 7, descricao: 'Y', quantidade: 1.5 }]);
    expect(r.rows[0].quantidade).toBe(2);
    expect(r.fractionalNotes[0]).toContain('1.5');
    expect(r.fractionalNotes[0]).toContain('2');
  });
  it('quantidade ≤ 0 é ignorada (não vira linha, não é bad)', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 1, quantidade: 0 }, { omie_codigo_produto: 2, quantidade: -3 }]);
    expect(r.rows).toHaveLength(0);
    expect(r.badCount).toBe(0);
  });
  it('quantidade inválida (string não-numérica/null) → badCount, pula', () => {
    const r = mapItemsToPickingRows([{ quantidade: 'abc' }, { quantidade: null }, { descricao: 'sem qtd' }]);
    expect(r.rows).toHaveLength(0);
    expect(r.badCount).toBe(3);
  });
  it('quantidade como string numérica é aceita', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 9, quantidade: '2.0' }]);
    expect(r.rows[0].quantidade).toBe(2);
  });
  it('código textual/ausente → omie_codigo_produto null, ainda vira linha', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 'AB12', descricao: 'Z', quantidade: 1 }]);
    expect(r.rows[0].omie_codigo_produto).toBeNull();
    expect(r.rows[0].product_descricao).toBe('Z');
  });
  it('items não-array → vazio', () => {
    expect(mapItemsToPickingRows(null).rows).toHaveLength(0);
    expect(mapItemsToPickingRows({} as unknown).rows).toHaveLength(0);
    expect(mapItemsToPickingRows('x' as unknown).badCount).toBe(0);
  });
});

describe('deriveParentStatus', () => {
  it('nada separado → pendente', () => {
    expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 0 }]).status).toBe('pendente');
  });
  it('parcial → em_andamento', () => {
    expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 2 }]).status).toBe('em_andamento');
  });
  it('tudo separado → concluido', () => {
    expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 5 }, { quantidade: 2, quantidade_separada: 2 }]).status).toBe('concluido');
  });
  it('separado além do esperado → concluido', () => {
    expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 6 }]).status).toBe('concluido');
  });
  it('lista vazia → pendente', () => {
    expect(deriveParentStatus([]).status).toBe('pendente');
  });
});
```

- [ ] **Step 2 — roda, falha** (módulo não existe): `heavy bun run test src/lib/picking/bridge-helpers.test.ts`
- [ ] **Step 3 — implementação** (`bridge-helpers.ts`):

```ts
export interface OrderItemJson {
  omie_codigo_produto?: number | string | null;
  descricao?: string | null;
  quantidade?: number | string | null;
}
export interface PickingItemRow {
  omie_codigo_produto: number | null;
  product_descricao: string;
  quantidade: number;
}
export interface MapResult { rows: PickingItemRow[]; fractionalNotes: string[]; badCount: number; }

const NUMERIC_RE = /^\s*[+-]?(\d+(\.\d+)?|\.\d+)\s*$/;

function parseNumeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { if (!NUMERIC_RE.test(v)) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function parseCodigo(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
  return null;
}

/** Mapeia sales_orders.items (jsonb) → linhas de picking_task_items. Oráculo testado da SQL ensure_picking_task_for_sales_order. */
export function mapItemsToPickingRows(items: unknown): MapResult {
  const rows: PickingItemRow[] = [];
  const fractionalNotes: string[] = [];
  let badCount = 0;
  if (!Array.isArray(items)) return { rows, fractionalNotes, badCount };
  for (const raw of items) {
    const elem = (raw ?? {}) as OrderItemJson;
    const qnum = parseNumeric(elem.quantidade);
    if (qnum === null) { badCount++; continue; }
    const qtd = Math.ceil(qnum);
    if (qtd <= 0) continue;
    const codigo = parseCodigo(elem.omie_codigo_produto);
    if (!Number.isInteger(qnum)) {
      fractionalNotes.push(`SKU ${codigo ?? elem.omie_codigo_produto ?? '—'}: ${qnum} → ${qtd} (arredondado p/ cima)`);
    }
    rows.push({ omie_codigo_produto: codigo, product_descricao: String(elem.descricao ?? ''), quantidade: qtd });
  }
  return { rows, fractionalNotes, badCount };
}

export interface ParentItem { quantidade: number; quantidade_separada: number; }
/** Deriva o status da task-pai por QUANTIDADE. Oráculo testado da SQL recalcular_picking_task. */
export function deriveParentStatus(items: ParentItem[]): { status: 'pendente' | 'em_andamento' | 'concluido' } {
  let total = 0, done = 0;
  for (const it of items) { total += it.quantidade ?? 0; done += it.quantidade_separada ?? 0; }
  if (done <= 0) return { status: 'pendente' };
  if (total > 0 && done >= total) return { status: 'concluido' };
  return { status: 'em_andamento' };
}
```

- [ ] **Step 4 — roda, passa.** `heavy bun run test src/lib/picking/bridge-helpers.test.ts`
- [ ] **Step 5 — commit.** `feat(picking): helper bridge-helpers (mapItems + deriveParentStatus, TDD)`

---

## Task 2: migration SQL — índices + 3 RPCs

**Files:**
- Create: `supabase/migrations/20260604120000_picking_bridge.sql`

- [ ] **Step 1 — escrever a migration** (espelha o helper verbatim; toda RPC = DEFINER + gate staff). Conteúdo:

```sql
-- Bridge de Picking da Oben: nascimento manual idempotente + fechamento atômico da task-pai.
-- Nenhuma RPC toca os syncs do Omie. Todas SECURITY DEFINER + gate staff (employee/master) —
-- lê sales_orders como owner (RLS de sales_orders é master|employee, ≠ picking) e seta
-- account/status/user_id server-side (anti-spoof). ⚠️ APLICAR MANUAL no SQL Editor.

-- Índice único parcial = backstop de idempotência do nascimento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_picking_tasks_sales_order
  ON public.picking_tasks (sales_order_id) WHERE sales_order_id IS NOT NULL;

-- Índice de candidatos da lista "Pedidos a separar".
CREATE INDEX IF NOT EXISTS idx_sales_orders_account_kpi
  ON public.sales_orders (account, order_date_kpi) WHERE deleted_at IS NULL;

-- Nasce a task (manual). Idempotente. Oben-only. Não cria task vazia.
CREATE OR REPLACE FUNCTION public.ensure_picking_task_for_sales_order(p_sales_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_so record; v_task uuid; v_items jsonb; elem jsonb;
  v_qraw text; v_qnum numeric; v_qtd integer; v_cod bigint;
  v_count integer := 0; v_bad integer := 0; v_notes text := '';
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_ensure:'||p_sales_order_id::text, 0));
  SELECT id, account, status, deleted_at, items INTO v_so FROM sales_orders WHERE id = p_sales_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido inexistente'; END IF;
  IF v_so.deleted_at IS NOT NULL OR v_so.status = 'cancelado' THEN
    RAISE EXCEPTION 'pedido inelegível (cancelado/excluído)';
  END IF;
  IF lower(coalesce(v_so.account,'')) <> 'oben' THEN
    RAISE EXCEPTION 'picking v1 somente Oben';
  END IF;
  SELECT id INTO v_task FROM picking_tasks WHERE sales_order_id = p_sales_order_id;
  IF v_task IS NOT NULL THEN RETURN jsonb_build_object('task_id', v_task, 'created', false); END IF;
  INSERT INTO picking_tasks (sales_order_id, account, status)
  VALUES (p_sales_order_id, lower(v_so.account), 'pendente')
  ON CONFLICT (sales_order_id) WHERE sales_order_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_task;
  IF v_task IS NULL THEN
    SELECT id INTO v_task FROM picking_tasks WHERE sales_order_id = p_sales_order_id;
    RETURN jsonb_build_object('task_id', v_task, 'created', false);
  END IF;
  v_items := CASE WHEN jsonb_typeof(v_so.items) = 'array' THEN v_so.items ELSE '[]'::jsonb END;
  FOR elem IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_qraw := elem->>'quantidade';
    IF v_qraw IS NULL OR v_qraw !~ '^\s*[+-]?(\d+(\.\d+)?|\.\d+)\s*$' THEN v_bad := v_bad + 1; CONTINUE; END IF;
    v_qnum := v_qraw::numeric;
    v_qtd := ceil(v_qnum)::integer;
    IF v_qtd <= 0 THEN CONTINUE; END IF;
    v_cod := CASE WHEN (elem->>'omie_codigo_produto') ~ '^\d+$' THEN (elem->>'omie_codigo_produto')::bigint ELSE NULL END;
    INSERT INTO picking_task_items (picking_task_id, omie_codigo_produto, product_descricao, quantidade, status)
    VALUES (v_task, v_cod, coalesce(elem->>'descricao',''), v_qtd, 'pendente');
    v_count := v_count + 1;
    IF v_qnum <> v_qtd THEN
      v_notes := v_notes || format('SKU %s: %s → %s; ', coalesce(elem->>'omie_codigo_produto','—'), v_qnum, v_qtd);
    END IF;
  END LOOP;
  IF v_count = 0 THEN RAISE EXCEPTION 'pedido sem itens válidos para separação'; END IF;
  IF v_notes <> '' THEN UPDATE picking_tasks SET notes = 'Qtd fracionária arredondada: '||v_notes WHERE id = v_task; END IF;
  RETURN jsonb_build_object('task_id', v_task, 'created', true, 'item_count', v_count, 'bad_count', v_bad);
END $$;

-- Recalcula o status da task-pai por QUANTIDADE. Pura/convergente.
CREATE OR REPLACE FUNCTION public.recalcular_picking_task(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_total numeric; v_done numeric; v_status text;
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  SELECT COALESCE(sum(quantidade),0), COALESCE(sum(quantidade_separada),0)
    INTO v_total, v_done FROM picking_task_items WHERE picking_task_id = p_task_id;
  IF v_done <= 0 THEN v_status := 'pendente';
  ELSIF v_total > 0 AND v_done >= v_total THEN v_status := 'concluido';
  ELSE v_status := 'em_andamento'; END IF;
  UPDATE picking_tasks SET
    status = v_status,
    started_at = COALESCE(started_at, CASE WHEN v_status <> 'pendente' THEN now() END),
    completed_at = CASE WHEN v_status = 'concluido' THEN COALESCE(completed_at, now()) ELSE NULL END
  WHERE id = p_task_id;
  RETURN jsonb_build_object('status', v_status);
END $$;

-- Confirma item: evento + update item (absoluto) + recalc pai, ATÔMICO. Idempotente p/ replay offline.
CREATE OR REPLACE FUNCTION public.confirmar_item_picking(
  p_event_id uuid, p_task_id uuid, p_item_id uuid, p_quantidade_separada integer,
  p_lote_informado text, p_justificativa text, p_confirmed_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_item record; v_div boolean; v_etype text;
  v_item_status text; v_total numeric; v_done numeric; v_parent text;
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  SELECT quantidade, lote_fefo INTO v_item FROM picking_task_items WHERE id = p_item_id AND picking_task_id = p_task_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'item inexistente'; END IF;
  v_div := (p_lote_informado IS NOT NULL AND v_item.lote_fefo IS NOT NULL AND p_lote_informado <> v_item.lote_fefo);
  v_etype := CASE WHEN v_div THEN 'lote_divergente' ELSE 'item_confirmado' END;
  INSERT INTO picking_events (id, picking_task_id, picking_task_item_id, event_type, lote_esperado, lote_informado, justificativa, user_id)
  VALUES (p_event_id, p_task_id, p_item_id, v_etype, v_item.lote_fefo, p_lote_informado, p_justificativa, v_uid)
  ON CONFLICT (id) DO NOTHING;
  v_item_status := CASE WHEN p_quantidade_separada >= v_item.quantidade THEN 'concluido' ELSE 'em_andamento' END;
  UPDATE picking_task_items SET
    quantidade_separada = p_quantidade_separada, status = v_item_status,
    lote_separado = p_lote_informado, justificativa_substituicao = p_justificativa, separado_at = p_confirmed_at
  WHERE id = p_item_id;
  -- recalc pai inline (mesma transação)
  SELECT COALESCE(sum(quantidade),0), COALESCE(sum(quantidade_separada),0)
    INTO v_total, v_done FROM picking_task_items WHERE picking_task_id = p_task_id;
  IF v_done <= 0 THEN v_parent := 'pendente';
  ELSIF v_total > 0 AND v_done >= v_total THEN v_parent := 'concluido';
  ELSE v_parent := 'em_andamento'; END IF;
  UPDATE picking_tasks SET
    status = v_parent,
    started_at = COALESCE(started_at, CASE WHEN v_parent <> 'pendente' THEN now() END),
    completed_at = CASE WHEN v_parent = 'concluido' THEN COALESCE(completed_at, now()) ELSE NULL END
  WHERE id = p_task_id;
  RETURN jsonb_build_object('ok', true, 'parent_status', v_parent);
END $$;

REVOKE ALL ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recalcular_picking_task(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalcular_picking_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) TO authenticated;
```

- [ ] **Step 2 — `bun run audit:migrations`** (regenera audit) e commit. `feat(picking): migration bridge (índices + 3 RPCs DEFINER)`

> ⚠️ Migration MANUAL: entregar BLOCO 0 (diagnóstico dupes) + BLOCO A (este SQL) + validação no PR e na conversa.

---

## Task 3: confirmPickItem → RPC atômica única

**Files:**
- Modify: `src/services/picking-confirm.ts`

- [ ] **Step 1 — reescrever o corpo** (mantém a interface `ConfirmPickItemVars`):

```ts
export async function confirmPickItem(vars: ConfirmPickItemVars): Promise<{ ok: true }> {
  const { error } = await supabase.rpc('confirmar_item_picking', {
    p_event_id: vars.eventId,
    p_task_id: vars.pickingTaskId,
    p_item_id: vars.pickingTaskItemId,
    p_quantidade_separada: vars.quantidadeSeparada,
    p_lote_informado: vars.loteInformado,
    p_justificativa: vars.justificativa,
    p_confirmed_at: vars.confirmedAt,
  });
  if (error) throw error;
  return { ok: true };
}
```
(Os campos `userId`/`quantidade`/`loteEsperado` da interface seguem no payload mas a RPC os deriva server-side; o optimistic-merge não muda.) Se `rpc` não estiver no types gerado p/ essas funções, usar o cast `(supabase as unknown as RpcClient).rpc(...)` como em `useRegistrarContato.ts`.

- [ ] **Step 2 — typecheck + test** (os testes de picking existentes devem seguir passando; se houver teste de picking-confirm que mocka 2 `.from()`, ajustar p/ mockar `.rpc()`). `heavy bun run typecheck && heavy bun run test src/`
- [ ] **Step 3 — commit.** `feat(picking): confirmPickItem usa RPC atômica confirmar_item_picking (fecha task-pai)`

---

## Task 4: frontend — "Pedidos a separar" + casing + KPI

**Files:**
- Create: `src/queries/useEnviarParaSeparacao.ts`, `src/queries/usePedidosASeparar.ts`
- Modify: `src/pages/AdminEstoquePicking.tsx`, `src/hooks/dashboard/useEstoqueZone.ts`

- [ ] **Step 1 — hook `useEnviarParaSeparacao`** (RPC ensure + invalidações + track):

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
type RpcClient = { rpc(fn: string, p?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
const rpc = () => supabase as unknown as RpcClient;

export function useEnviarParaSeparacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (salesOrderId: string): Promise<{ task_id: string; created: boolean }> => {
      const { data, error } = await rpc().rpc('ensure_picking_task_for_sales_order', { p_sales_order_id: salesOrderId });
      if (error) throw new Error(error.message);
      return data as { task_id: string; created: boolean };
    },
    onSuccess: () => {
      track('picking.enviado_separacao', {});
      qc.invalidateQueries({ queryKey: ['pk-pedidos-a-separar'] });
      qc.invalidateQueries({ queryKey: ['pk-picking-list'] });
      qc.invalidateQueries({ queryKey: ['pk-tasks-abertas'] });
    },
  });
}
```

- [ ] **Step 2 — hook `usePedidosASeparar(account)`** (candidatos sem task; usa `mapItemsToPickingRows` p/ item count + flag fracionário):

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mapItemsToPickingRows } from '@/lib/picking/bridge-helpers';

export interface PedidoASeparar {
  id: string; customer_user_id: string; total: number; status: string;
  data: string | null; itemCount: number; hasFractional: boolean;
}
export function usePedidosASeparar(account: string) {
  const acc = account.toLowerCase();
  return useQuery({
    queryKey: ['pk-pedidos-a-separar', acc],
    queryFn: async (): Promise<PedidoASeparar[]> => {
      const desde = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const { data: cand } = await supabase
        .from('sales_orders')
        .select('id, customer_user_id, total, status, order_date_kpi, created_at, items')
        .eq('account', acc)
        .is('deleted_at', null)
        .not('status', 'in', '(cancelado,rascunho)')
        .gte('order_date_kpi', desde)
        .order('order_date_kpi', { ascending: false })
        .limit(100);
      const ids = (cand ?? []).map((o) => o.id);
      if (ids.length === 0) return [];
      const { data: existing } = await supabase
        .from('picking_tasks').select('sales_order_id').in('sales_order_id', ids);
      const comTask = new Set((existing ?? []).map((t) => t.sales_order_id));
      return (cand ?? []).filter((o) => !comTask.has(o.id)).map((o) => {
        const m = mapItemsToPickingRows(o.items);
        return {
          id: o.id, customer_user_id: o.customer_user_id, total: Number(o.total ?? 0),
          status: o.status, data: o.order_date_kpi ?? (o.created_at?.slice(0, 10) ?? null),
          itemCount: m.rows.length, hasFractional: m.fractionalNotes.length > 0,
        };
      });
    },
    refetchInterval: 60000,
  });
}
```
> ⚠️ `.gte('order_date_kpi', desde)` exclui pedidos com `order_date_kpi` NULL. Aceitável (a lista é janela recente; pedidos antigos sem KPI não são candidatos típicos). Alternativa se faltar candidato: `.or(order_date_kpi.gte.X,and(order_date_kpi.is.null,created_at.gte.X))` — mas usar helper de postgrest (não template cru). Decidir na execução conforme dado; default = `.gte` simples.

- [ ] **Step 3 — aba "Pedidos a separar" no `AdminEstoquePicking`**: nova `TabsTrigger` + `TabsContent`. Componente `PedidosASepararTab({ account })` lista os pedidos (cliente truncado/total/status com aviso/data/itemCount + badge "fracionário") com botão `size="sm"` "Enviar para separação" (`useEnviarParaSeparacao`, `disabled` enquanto `isPending`, toast com `created ? 'Task criada' : 'Já estava em separação'`). Aviso no topo: "O status vem do Omie e pode estar desatualizado — confira antes de enviar."

- [ ] **Step 4 — fix casing**: nas queries de `picking_tasks` do `AdminEstoquePicking` (`KpiCards`, `PickingTab`, `AuditoriaTab`) trocar `.eq('account', account)` por `.eq('account', account.toLowerCase())`. **NÃO** tocar `inventory_position`. Adicionar `pickingAccount` derivado onde fizer sentido.

- [ ] **Step 5 — fix KPI `useEstoqueZone.ts:65`**: `.eq('status','pendente')` → `.in('status', ['pendente','em_andamento'])`.

- [ ] **Step 6 — typecheck + test + lint + build.** `heavy bun run typecheck && heavy bun run test src/ && bun lint && heavy bun run build`
- [ ] **Step 7 — commit.** `feat(picking): aba "Pedidos a separar" + casing fix + KPI estoque`

---

## Task 5: Codex adversarial + validação + PR + CLAUDE.md

- [ ] **Step 1 — Codex challenge no código** (`codex exec` -m gpt-5.5, diff completo). Incorporar P1/P2.
- [ ] **Step 2 — CI local verde** (typecheck strict + test + lint + build via `heavy`).
- [ ] **Step 3 — push + PR** com nota "⚠️ migration manual" + BLOCO 0 (diagnóstico dupes) + BLOCO A (SQL) + validação inline.
- [ ] **Step 4 — entregar SQL na conversa** (blocos pro SQL Editor, 1 por mensagem, formato §5).
- [ ] **Step 5 — auto-merge** (`gh pr merge --squash --auto`).
- [ ] **Step 6 — registrar no CLAUDE.md** §5/§6(item 1)/§10: bridge de picking, nascimento manual, 3 RPCs, casing fix, sinal 'separacao' quebrado documentado.

## Self-review (writing-plans)
- Cobertura do spec: helper (T1), 3 RPCs+índices (T2), morte atômica (T3), nascimento manual+casing+KPI (T4), entrega (T5). ✓
- Tipos consistentes: `ConfirmPickItemVars` inalterado; `PedidoASeparar`/`MapResult` definidos. ✓
- Sem placeholders: código real em cada step. ✓
