/** Agrupa visitas por resultado (route_visits) num breakdown ordenado, com receita por bucket. Puro. */

export interface VisitaConversaoRow {
  result: string | null;
  revenue_generated: number | null;
}
interface ConversaoBucket {
  result: string; // código (pedido_fechado/.../sem_resultado)
  count: number;
  revenue: number;
  pct: number; // count / total (0..1); 0 se total 0
}
export interface ConversaoResumo {
  total: number;
  receitaTotal: number;
  buckets: ConversaoBucket[];
}

const ORDEM = ['pedido_fechado', 'interesse', 'reagendar', 'sem_interesse', 'ausente'];

function rank(k: string): number {
  const i = ORDEM.indexOf(k);
  if (i !== -1) return i;
  return k === 'sem_resultado' ? 99 : 50; // outros no meio; sem_resultado por último
}

export function agruparVisitasPorResultado(rows: VisitaConversaoRow[]): ConversaoResumo {
  const total = rows.length;
  const receitaTotal = rows.reduce((s, r) => s + (r.revenue_generated ?? 0), 0);

  const counts = new Map<string, { count: number; revenue: number }>();
  for (const r of rows) {
    const key = r.result ?? 'sem_resultado';
    const cur = counts.get(key) ?? { count: 0, revenue: 0 };
    cur.count += 1;
    cur.revenue += r.revenue_generated ?? 0;
    counts.set(key, cur);
  }

  const buckets: ConversaoBucket[] = [...counts.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([result, c]) => ({
      result,
      count: c.count,
      revenue: c.revenue,
      pct: total > 0 ? c.count / total : 0,
    }));

  return { total, receitaTotal, buckets };
}
