type VisitResultTone = 'success' | 'info' | 'error' | 'warning' | 'muted';
export interface VisitResultLabel {
  label: string;
  emoji: string;
  tone: VisitResultTone;
}

/** Código de `route_visits.result` → rótulo + emoji + tom (tokens text-status-*). */
export function visitResultLabel(result: string | null): VisitResultLabel {
  switch (result) {
    case 'pedido_fechado': return { label: 'Pedido fechado', emoji: '✅', tone: 'success' };
    case 'interesse':      return { label: 'Interesse',      emoji: '🤔', tone: 'info' };
    case 'sem_interesse':  return { label: 'Sem interesse',  emoji: '❌', tone: 'error' };
    case 'ausente':        return { label: 'Ausente',        emoji: '🚫', tone: 'warning' };
    case 'reagendar':      return { label: 'Reagendar',      emoji: '📅', tone: 'warning' };
    default:               return { label: 'Sem resultado',  emoji: '—',  tone: 'muted' };
  }
}

export interface VisitResumoRow {
  result: string | null;
  revenue_generated: number | null;
}
export interface VisitResumo {
  total: number;
  comResultado: number;
  fechados: number;
  taxaConversao: number | null;
  receitaTotal: number;
}

/** Resumo do histórico. taxaConversao = fechados ÷ visitas COM resultado (null se base 0). */
export function resumoVisitas(rows: VisitResumoRow[]): VisitResumo {
  const total = rows.length;
  const comResultado = rows.filter((r) => r.result != null).length;
  const fechados = rows.filter((r) => r.result === 'pedido_fechado').length;
  const taxaConversao = comResultado > 0 ? fechados / comResultado : null;
  const receitaTotal = rows.reduce((s, r) => s + (r.revenue_generated ?? 0), 0);
  return { total, comResultado, fechados, taxaConversao, receitaTotal };
}
