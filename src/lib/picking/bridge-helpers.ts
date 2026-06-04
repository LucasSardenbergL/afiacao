/**
 * Helpers puros do bridge de picking — oráculos testados que as RPCs SQL espelham verbatim
 * (`ensure_picking_task_for_sales_order` e `recalcular_picking_task`).
 *
 * `mapItemsToPickingRows` converte `sales_orders.items` (jsonb, formato do omie-vendas-sync) em
 * linhas de `picking_task_items` — com arredondamento p/ cima (nunca separar a menos), nota de
 * fracionário, e blindagem contra jsonb malformado.
 */

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

export interface MapResult {
  rows: PickingItemRow[];
  fractionalNotes: string[];
  badCount: number;
}

const NUMERIC_RE = /^\s*[+-]?(\d+(\.\d+)?|\.\d+)\s*$/;

function parseNumeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (!NUMERIC_RE.test(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseCodigo(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** Mapeia sales_orders.items (jsonb) → linhas de picking_task_items. Oráculo da SQL ensure_picking_task_for_sales_order. */
export function mapItemsToPickingRows(items: unknown): MapResult {
  const rows: PickingItemRow[] = [];
  const fractionalNotes: string[] = [];
  let badCount = 0;
  if (!Array.isArray(items)) return { rows, fractionalNotes, badCount };
  for (const raw of items) {
    const elem = (raw ?? {}) as OrderItemJson;
    const qnum = parseNumeric(elem.quantidade);
    if (qnum === null) {
      badCount++;
      continue;
    }
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

export interface ParentItem {
  quantidade: number;
  quantidade_separada: number;
}

/** Deriva o status da task-pai por QUANTIDADE. Oráculo da SQL recalcular_picking_task. */
export function deriveParentStatus(items: ParentItem[]): { status: 'pendente' | 'em_andamento' | 'concluido' } {
  let total = 0;
  let done = 0;
  for (const it of items) {
    total += it.quantidade ?? 0;
    done += it.quantidade_separada ?? 0;
  }
  if (done <= 0) return { status: 'pendente' };
  if (total > 0 && done >= total) return { status: 'concluido' };
  return { status: 'em_andamento' };
}
