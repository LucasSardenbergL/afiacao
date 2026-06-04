# Bridge de Picking da Oben — plano de implementação (v2, pós-Codex no plano)

> **Para workers agênticos:** SUB-SKILL: superpowers:subagent-driven-development. Steps com checkbox.

**Goal:** ligar pedido de venda Oben → task de separação (nascimento manual idempotente) → confirmação fecha a task-pai, sem tocar nos syncs do Omie.

**Arquitetura:** helper puro TDD (oráculo) espelhado em 4 RPCs `SECURITY DEFINER` (gate staff employee/master); frontend manual ("Enviar para separação") + confirmPickItem reescrito p/ RPC atômica única.

**Spec:** `docs/superpowers/specs/2026-06-04-picking-bridge-design.md`.

**Tech:** React 18 + TS strict + Supabase (plpgsql) + vitest. `account` lowercase. `app_role` = master|employee|customer (confirmado).

---

## Task 1: helper puro `bridge-helpers.ts` (TDD)

**Files:** Create `src/lib/picking/bridge-helpers.ts` + `src/lib/picking/bridge-helpers.test.ts`

- [ ] **Step 1 — teste falhando** (cobre os ramos pedidos pelo Codex):

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
  it('quantidade ≤ 0 e fracionária negativa são ignoradas (não viram linha, não são bad)', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 1, quantidade: 0 }, { omie_codigo_produto: 2, quantidade: -3 }, { omie_codigo_produto: 3, quantidade: -1.5 }]);
    expect(r.rows).toHaveLength(0);
    expect(r.fractionalNotes).toHaveLength(0);
    expect(r.badCount).toBe(0);
  });
  it('quantidade inválida (string não-numérica/null/ausente) e item null → badCount, pula', () => {
    const r = mapItemsToPickingRows([{ quantidade: 'abc' }, { quantidade: null }, { descricao: 'sem qtd' }, null]);
    expect(r.rows).toHaveLength(0);
    expect(r.badCount).toBe(4);
  });
  it('string numérica (com espaços) é aceita', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 9, descricao: 'S', quantidade: ' 2 ' }]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({ omie_codigo_produto: 9, product_descricao: 'S', quantidade: 2 });
    expect(r.badCount).toBe(0);
  });
  it('código textual / 0 → omie_codigo_produto null, ainda vira linha; descricao null → ""', () => {
    const r = mapItemsToPickingRows([{ omie_codigo_produto: 'AB12', descricao: null, quantidade: 1 }, { omie_codigo_produto: 0, descricao: 'Z', quantidade: 1 }]);
    expect(r.rows[0]).toEqual({ omie_codigo_produto: null, product_descricao: '', quantidade: 1 });
    expect(r.rows[1].omie_codigo_produto).toBeNull();
  });
  it('items não-array → vazio', () => {
    expect(mapItemsToPickingRows(null).rows).toHaveLength(0);
    expect(mapItemsToPickingRows({} as unknown).rows).toHaveLength(0);
    expect(mapItemsToPickingRows('x' as unknown).badCount).toBe(0);
  });
});

describe('deriveParentStatus', () => {
  it('nada separado → pendente', () => { expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 0 }]).status).toBe('pendente'); });
  it('parcial → em_andamento', () => { expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 2 }]).status).toBe('em_andamento'); });
  it('tudo separado → concluido', () => { expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 5 }, { quantidade: 2, quantidade_separada: 2 }]).status).toBe('concluido'); });
  it('separado além do esperado → concluido', () => { expect(deriveParentStatus([{ quantidade: 5, quantidade_separada: 6 }]).status).toBe('concluido'); });
  it('lista vazia → pendente', () => { expect(deriveParentStatus([]).status).toBe('pendente'); });
});
```

- [ ] **Step 2 — roda, falha.** `heavy bun run test src/lib/picking/bridge-helpers.test.ts`
- [ ] **Step 3 — implementação** (`bridge-helpers.ts`): igual ao snippet abaixo. `parseCodigo` exige `> 0` (alinha com a SQL); `parseNumeric` aceita string numérica (regex) e número finito; item `null`→`{}`→quantidade undefined→badCount.

```ts
export interface OrderItemJson { omie_codigo_produto?: number | string | null; descricao?: string | null; quantidade?: number | string | null; }
export interface PickingItemRow { omie_codigo_produto: number | null; product_descricao: string; quantidade: number; }
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
export function mapItemsToPickingRows(items: unknown): MapResult {
  const rows: PickingItemRow[] = []; const fractionalNotes: string[] = []; let badCount = 0;
  if (!Array.isArray(items)) return { rows, fractionalNotes, badCount };
  for (const raw of items) {
    const elem = (raw ?? {}) as OrderItemJson;
    const qnum = parseNumeric(elem.quantidade);
    if (qnum === null) { badCount++; continue; }
    const qtd = Math.ceil(qnum);
    if (qtd <= 0) continue;
    const codigo = parseCodigo(elem.omie_codigo_produto);
    if (!Number.isInteger(qnum)) fractionalNotes.push(`SKU ${codigo ?? elem.omie_codigo_produto ?? '—'}: ${qnum} → ${qtd} (arredondado p/ cima)`);
    rows.push({ omie_codigo_produto: codigo, product_descricao: String(elem.descricao ?? ''), quantidade: qtd });
  }
  return { rows, fractionalNotes, badCount };
}
export interface ParentItem { quantidade: number; quantidade_separada: number; }
export function deriveParentStatus(items: ParentItem[]): { status: 'pendente' | 'em_andamento' | 'concluido' } {
  let total = 0, done = 0;
  for (const it of items) { total += it.quantidade ?? 0; done += it.quantidade_separada ?? 0; }
  if (done <= 0) return { status: 'pendente' };
  if (total > 0 && done >= total) return { status: 'concluido' };
  return { status: 'em_andamento' };
}
```

- [ ] **Step 4 — roda, passa.** `heavy bun run test src/lib/picking/bridge-helpers.test.ts`
- [ ] **Step 5 — commit.** `feat(picking): helper bridge-helpers (TDD)`

---

## Task 2: migration SQL — índices + 4 RPCs (todas DEFINER + gate staff)

**Files:** Create `supabase/migrations/20260604120000_picking_bridge.sql`

- [ ] **Step 1 — escrever a migration.** Conteúdo (espelha o helper; gate staff; locks; guards do Codex):

```sql
-- Bridge de Picking da Oben: nascimento manual idempotente + fechamento atômico da task-pai.
-- Todas SECURITY DEFINER + gate staff (employee/master); lê sales_orders como owner; account/status/user_id server-side.
-- ⚠️ APLICAR MANUAL no SQL Editor. BLOCO 0 (diagnóstico) roda ANTES; se acusar dupes, resolver antes do índice.

CREATE UNIQUE INDEX IF NOT EXISTS uq_picking_tasks_sales_order
  ON public.picking_tasks (sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_account_kpi
  ON public.sales_orders (account, order_date_kpi) WHERE deleted_at IS NULL;

-- Nasce a task (manual, Oben-only, idempotente, nunca vazia).
CREATE OR REPLACE FUNCTION public.ensure_picking_task_for_sales_order(p_sales_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_so record; v_task uuid; v_items jsonb; elem jsonb;
  v_qraw text; v_qnum numeric; v_qtd integer; v_cod bigint; v_count integer := 0; v_bad integer := 0; v_notes text := '';
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN RAISE EXCEPTION 'forbidden: staff only'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_ensure:'||p_sales_order_id::text, 0));
  SELECT id, account, status, deleted_at, items INTO v_so FROM sales_orders WHERE id = p_sales_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido inexistente'; END IF;
  IF v_so.deleted_at IS NOT NULL OR v_so.status IN ('cancelado','rascunho','orcamento') THEN
    RAISE EXCEPTION 'pedido inelegível (cancelado/rascunho/orçamento/excluído)'; END IF;
  IF lower(coalesce(v_so.account,'')) <> 'oben' THEN RAISE EXCEPTION 'picking v1 somente Oben'; END IF;
  SELECT id INTO v_task FROM picking_tasks WHERE sales_order_id = p_sales_order_id;
  IF v_task IS NOT NULL THEN RETURN jsonb_build_object('task_id', v_task, 'created', false); END IF;
  INSERT INTO picking_tasks (sales_order_id, account, status)
  VALUES (p_sales_order_id, lower(v_so.account), 'pendente')
  ON CONFLICT (sales_order_id) WHERE sales_order_id IS NOT NULL DO NOTHING RETURNING id INTO v_task;
  IF v_task IS NULL THEN
    SELECT id INTO v_task FROM picking_tasks WHERE sales_order_id = p_sales_order_id;
    RETURN jsonb_build_object('task_id', v_task, 'created', false);
  END IF;
  v_items := CASE WHEN jsonb_typeof(v_so.items) = 'array' THEN v_so.items ELSE '[]'::jsonb END;
  FOR elem IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_qraw := elem->>'quantidade';
    IF v_qraw IS NULL OR v_qraw !~ '^\s*[+-]?(\d+(\.\d+)?|\.\d+)\s*$' THEN v_bad := v_bad + 1; CONTINUE; END IF;
    v_qnum := v_qraw::numeric; v_qtd := ceil(v_qnum)::integer;
    IF v_qtd <= 0 THEN CONTINUE; END IF;
    v_cod := CASE WHEN (elem->>'omie_codigo_produto') ~ '^\d+$' AND (elem->>'omie_codigo_produto')::bigint > 0
                  THEN (elem->>'omie_codigo_produto')::bigint ELSE NULL END;
    INSERT INTO picking_task_items (picking_task_id, omie_codigo_produto, product_descricao, quantidade, status)
    VALUES (v_task, v_cod, coalesce(elem->>'descricao',''), v_qtd, 'pendente');
    v_count := v_count + 1;
    IF v_qnum <> v_qtd THEN v_notes := v_notes || format('SKU %s: %s → %s; ', coalesce(elem->>'omie_codigo_produto','—'), v_qnum, v_qtd); END IF;
  END LOOP;
  IF v_count = 0 THEN RAISE EXCEPTION 'pedido sem itens válidos para separação'; END IF;
  IF v_notes <> '' THEN UPDATE picking_tasks SET notes = 'Qtd fracionária arredondada: '||v_notes WHERE id = v_task; END IF;
  RETURN jsonb_build_object('task_id', v_task, 'created', true, 'item_count', v_count, 'bad_count', v_bad);
END $$;

-- Recalcula status da task-pai por QUANTIDADE. Lock por task serializa concorrência (P1 Codex).
CREATE OR REPLACE FUNCTION public.recalcular_picking_task(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_total numeric; v_done numeric; v_status text;
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN RAISE EXCEPTION 'forbidden: staff only'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_task:'||p_task_id::text, 0));
  SELECT COALESCE(sum(quantidade),0), COALESCE(sum(quantidade_separada),0) INTO v_total, v_done
    FROM picking_task_items WHERE picking_task_id = p_task_id;
  IF v_done <= 0 THEN v_status := 'pendente';
  ELSIF v_total > 0 AND v_done >= v_total THEN v_status := 'concluido';
  ELSE v_status := 'em_andamento'; END IF;
  UPDATE picking_tasks SET status = v_status,
    started_at = COALESCE(started_at, CASE WHEN v_status <> 'pendente' THEN now() END),
    completed_at = CASE WHEN v_status = 'concluido' THEN COALESCE(completed_at, now()) ELSE NULL END
  WHERE id = p_task_id;
  RETURN jsonb_build_object('status', v_status);
END $$;

-- Confirma item: evento + update item (absoluto) + recalc pai (via PERFORM, sem duplicar lógica), ATÔMICO.
-- Idempotente p/ replay offline (evento por PK, update absoluto, recalc puro). 1 separador por item (last-write).
CREATE OR REPLACE FUNCTION public.confirmar_item_picking(
  p_event_id uuid, p_task_id uuid, p_item_id uuid, p_quantidade_separada integer,
  p_lote_informado text, p_justificativa text, p_confirmed_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_item record; v_div boolean; v_etype text; v_item_status text; v_parent text;
BEGIN
  IF NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN RAISE EXCEPTION 'forbidden: staff only'; END IF;
  IF p_quantidade_separada IS NULL OR p_quantidade_separada < 0 THEN RAISE EXCEPTION 'quantidade separada inválida'; END IF;
  SELECT quantidade, lote_fefo INTO v_item FROM picking_task_items WHERE id = p_item_id AND picking_task_id = p_task_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'item inexistente'; END IF;
  v_div := (p_lote_informado IS NOT NULL AND v_item.lote_fefo IS NOT NULL AND p_lote_informado <> v_item.lote_fefo);
  v_etype := CASE WHEN v_div THEN 'lote_divergente' ELSE 'item_confirmado' END;
  INSERT INTO picking_events (id, picking_task_id, picking_task_item_id, event_type, lote_esperado, lote_informado, justificativa, user_id)
  VALUES (p_event_id, p_task_id, p_item_id, v_etype, v_item.lote_fefo, p_lote_informado, p_justificativa, v_uid)
  ON CONFLICT (id) DO NOTHING;
  v_item_status := CASE WHEN p_quantidade_separada >= v_item.quantidade THEN 'concluido' ELSE 'em_andamento' END;
  UPDATE picking_task_items SET quantidade_separada = p_quantidade_separada, status = v_item_status,
    lote_separado = p_lote_informado, justificativa_substituicao = p_justificativa, separado_at = p_confirmed_at
  WHERE id = p_item_id;
  v_parent := (public.recalcular_picking_task(p_task_id))->>'status';  -- mesma tx, lock interno serializa o pai
  RETURN jsonb_build_object('ok', true, 'parent_status', v_parent);
END $$;

-- Lista candidatos "a separar" (anti-join + COALESCE de data, server-side). Gate staff (DEFINER → não vaza p/ customer).
CREATE OR REPLACE FUNCTION public.listar_pedidos_a_separar(p_account text)
RETURNS TABLE (id uuid, customer_user_id uuid, total numeric, status text, data date, items jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role)) THEN RAISE EXCEPTION 'forbidden: staff only'; END IF;
  RETURN QUERY
    SELECT so.id, so.customer_user_id, so.total, so.status,
           COALESCE(so.order_date_kpi, so.created_at::date) AS data, so.items
    FROM sales_orders so
    WHERE lower(so.account) = lower(p_account)
      AND so.deleted_at IS NULL
      AND so.status NOT IN ('cancelado','rascunho','orcamento')
      AND COALESCE(so.order_date_kpi, so.created_at::date) >= current_date - 60
      AND NOT EXISTS (SELECT 1 FROM picking_tasks pt WHERE pt.sales_order_id = so.id)
    ORDER BY COALESCE(so.order_date_kpi, so.created_at::date) DESC
    LIMIT 100;
END $$;

REVOKE ALL ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recalcular_picking_task(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.listar_pedidos_a_separar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalcular_picking_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_pedidos_a_separar(text) TO authenticated;
```

- [ ] **Step 2 — `bun run audit:migrations` + commit.** `feat(picking): migration bridge (índices + 4 RPCs DEFINER)`

> ⚠️ Manual. BLOCO 0 (rodar ANTES): `SELECT sales_order_id, count(*) FROM public.picking_tasks WHERE sales_order_id IS NOT NULL GROUP BY 1 HAVING count(*)>1;` → esperado 0 linhas.

---

## Task 3: confirmPickItem → RPC atômica + offline robusto

**Files:** Modify `src/services/picking-confirm.ts`, `src/hooks/useOfflineMutation.ts` (+ test)

- [ ] **Step 1 — reescrever `confirmPickItem`** (mantém `ConfirmPickItemVars`):

```ts
export async function confirmPickItem(vars: ConfirmPickItemVars): Promise<{ ok: true }> {
  const { error } = await (supabase as unknown as { rpc(fn: string, p?: Record<string, unknown>): Promise<{ error: { message: string } | null }> }).rpc('confirmar_item_picking', {
    p_event_id: vars.eventId, p_task_id: vars.pickingTaskId, p_item_id: vars.pickingTaskItemId,
    p_quantidade_separada: vars.quantidadeSeparada, p_lote_informado: vars.loteInformado,
    p_justificativa: vars.justificativa, p_confirmed_at: vars.confirmedAt,
  });
  if (error) throw error;
  return { ok: true };
}
```

- [ ] **Step 2 — ampliar `isNetworkError`** (P1 Codex — `.rpc()` pode lançar objeto plain `{message}`): adicionar, após os checks existentes, um ramo p/ objeto plain com `message` de rede:

```ts
if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
    && /networkerror|failed to fetch|load failed|network request failed/i.test((err as { message: string }).message)) return true;
```
+ teste em `src/hooks/useOfflineMutation.test.ts` (criar se não existir): `expect(isNetworkError({ message: 'TypeError: Failed to fetch' })).toBe(true)` e um negativo `expect(isNetworkError({ message: 'permission denied' })).toBe(false)`. (Exportar `isNetworkError` se ainda não for — ou testar via comportamento do hook.)

- [ ] **Step 3 — typecheck + test.** `heavy bun run typecheck && heavy bun run test src/`. ⚠️ Se houver teste existente de `picking-confirm` que mocka 2 `.from()`, reescrever p/ mockar `.rpc()`.
- [ ] **Step 4 — commit.** `feat(picking): confirmPickItem via RPC atômica + offline robusto p/ .rpc()`

---

## Task 4a: hooks (RPC list + enviar)

**Files:** Create `src/queries/usePedidosASeparar.ts`, `src/queries/useEnviarParaSeparacao.ts`

- [ ] **Step 1 — `usePedidosASeparar`** (RPC server-side; lança em erro; mapeia items p/ count/fracionário):

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mapItemsToPickingRows } from '@/lib/picking/bridge-helpers';
type RpcClient = { rpc(fn: string, p?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
export interface PedidoASeparar { id: string; customer_user_id: string; total: number; status: string; data: string | null; itemCount: number; hasFractional: boolean; }
interface Row { id: string; customer_user_id: string; total: number; status: string; data: string | null; items: unknown; }
export function usePedidosASeparar(account: string) {
  const acc = account.toLowerCase();
  return useQuery({
    queryKey: ['pk-pedidos-a-separar', acc],
    queryFn: async (): Promise<PedidoASeparar[]> => {
      const { data, error } = await (supabase as unknown as RpcClient).rpc('listar_pedidos_a_separar', { p_account: acc });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Row[]).map((o) => {
        const m = mapItemsToPickingRows(o.items);
        return { id: o.id, customer_user_id: o.customer_user_id, total: Number(o.total ?? 0), status: o.status, data: o.data, itemCount: m.rows.length, hasFractional: m.fractionalNotes.length > 0 };
      });
    },
    refetchInterval: 60000,
  });
}
```

- [ ] **Step 2 — `useEnviarParaSeparacao`** (RPC ensure + invalidações completas):

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
type RpcClient = { rpc(fn: string, p?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
export function useEnviarParaSeparacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (salesOrderId: string): Promise<{ task_id: string; created: boolean }> => {
      const { data, error } = await (supabase as unknown as RpcClient).rpc('ensure_picking_task_for_sales_order', { p_sales_order_id: salesOrderId });
      if (error) throw new Error(error.message);
      return data as { task_id: string; created: boolean };
    },
    onSuccess: () => {
      track('picking.enviado_separacao', {});
      for (const k of [['pk-pedidos-a-separar'], ['pk-picking-list'], ['pk-tasks-abertas'], ['pk-pedidos-aguardando'], ['touch-pk-tasks']]) {
        qc.invalidateQueries({ queryKey: k });
      }
    },
  });
}
```

- [ ] **Step 3 — typecheck.** `heavy bun run typecheck` · commit `feat(picking): hooks usePedidosASeparar + useEnviarParaSeparacao`

---

## Task 4b: UI da aba "Pedidos a separar"

**Files:** Modify `src/pages/AdminEstoquePicking.tsx`

- [ ] **Step 1 — `PedidosASepararTab({ account })`**: usa `usePedidosASeparar(account)` + `useEnviarParaSeparacao`. Tabela: cliente (truncado `customer_user_id`), total (fmtBRL), status (com aviso), data, itens (`itemCount` + badge "fracionário" se `hasFractional`), botão `size="sm"` "Enviar para separação" (`onClick` → `enviar.mutate(id)`, `disabled={enviar.isPending}`, toast `created ? 'Task de separação criada' : 'Pedido já estava em separação'`, `onError` toast.error). Aviso no topo (texto): "O status vem do Omie e pode estar desatualizado — confira antes de enviar." EmptyState quando vazio.
- [ ] **Step 2 — registrar a aba**: `TabsTrigger value="a-separar"` (primeira, antes de "picking") + `TabsContent`. Ajustar `grid-cols` do `TabsList` (5 abas).
- [ ] **Step 3 — typecheck + test + lint.** `heavy bun run typecheck && heavy bun run test src/ && bun lint` · commit `feat(picking): aba "Pedidos a separar"`

---

## Task 4c: casing + KPI

**Files:** Modify `src/pages/AdminEstoquePicking.tsx`, `src/hooks/dashboard/useEstoqueZone.ts`

- [ ] **Step 1 — casing**: nas queries de `picking_tasks` do `AdminEstoquePicking` (`KpiCards` 3×, `PickingTab`, `AuditoriaTab`) trocar `.eq("account", account)` → `.eq("account", account.toLowerCase())`. **NÃO** tocar `inventory_position`.
- [ ] **Step 2 — KPI `useEstoqueZone.ts:65`**: `.eq('status','pendente')` → `.in('status', ['pendente','em_andamento'])`.
- [ ] **Step 3 — typecheck + test + build.** `heavy bun run typecheck && heavy bun run test src/ && heavy bun run build` · commit `fix(picking): casing lowercase nas queries de picking_tasks + KPI estoque`

---

## Task 5: Codex adversarial + validação + PR + CLAUDE.md

- [ ] **Step 1 — Codex challenge no código** (`codex exec -m gpt-5.5`, diff completo). Incorporar P1/P2.
- [ ] **Step 2 — CI local verde.** `heavy bun run typecheck && heavy bun run test && bun lint && heavy bun run build`.
- [ ] **Step 3 — push + PR** ("⚠️ migration manual" + BLOCO 0 + BLOCO A + validação inline).
- [ ] **Step 4 — entregar SQL na conversa** (blocos pro SQL Editor, formato §5).
- [ ] **Step 5 — auto-merge** `gh pr merge --squash --auto`.
- [ ] **Step 6 — CLAUDE.md** §5/§6(item1)/§10: bridge de picking, nascimento manual, 4 RPCs DEFINER, casing fix, sinal 'separacao' quebrado documentado, lição do modelo codex CLI (gpt-5.5).

## Self-review
- Spec coberto: helper (T1), 4 RPCs+índices (T2), morte atômica+offline (T3), hooks (T4a), UI (T4b), casing+KPI (T4c), entrega (T5). ✓
- Tipos: `ConfirmPickItemVars` inalterado; `PedidoASeparar`/`MapResult` def. ✓
- P1 Codex: lock pai (recalcular), orcamento (ensure+list), order_date_kpi COALESCE (RPC list), offline .rpc() (isNetworkError), qty<0 (confirmar), code>0 (SQL). ✓
- Sem placeholders. ✓
