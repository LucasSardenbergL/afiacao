/**
 * KPIs de visita do vendedor (dashboard Closer). Puro e testável.
 * Definições deliberadas (validadas com codex — ver spec):
 *  - taxaConversao = fechados ÷ visitas COM resultado (expõe `semResultado` p/ não mascarar
 *    quem não registra visita ruim);
 *  - ticketMedio = receita ÷ fechados COM valor>0 (não dilui com fechados sem receita;
 *    expõe `fechadosSemValor` como buraco de dado).
 * Spec: docs/superpowers/specs/2026-06-04-followups-sugeridos-design.md (seção KPIs).
 */
export interface KpiVisitaRow {
  result: string | null;
  revenue_generated: number | null;
}

export interface KpisVisita {
  totalVisitas: number;
  comResultado: number;
  semResultado: number;
  fechados: number;
  taxaConversao: number | null; // fração 0..1; null se não há visita com resultado
  fechadosComValor: number;
  fechadosSemValor: number;
  receitaTotal: number; // soma da receita dos fechados COM valor
  ticketMedio: number | null; // receitaTotal ÷ fechadosComValor; null se nenhum
}

export function montarKpisVisita(rows: KpiVisitaRow[]): KpisVisita {
  const totalVisitas = rows.length;
  const comResultado = rows.filter((r) => r.result != null).length;
  const semResultado = totalVisitas - comResultado;

  const fechadosRows = rows.filter((r) => r.result === 'pedido_fechado');
  const fechados = fechadosRows.length;
  const taxaConversao = comResultado > 0 ? fechados / comResultado : null;

  const comValor = fechadosRows.filter((r) => (r.revenue_generated ?? 0) > 0);
  const fechadosComValor = comValor.length;
  const fechadosSemValor = fechados - fechadosComValor;
  const receitaTotal = comValor.reduce((s, r) => s + (r.revenue_generated ?? 0), 0);
  const ticketMedio = fechadosComValor > 0 ? receitaTotal / fechadosComValor : null;

  return {
    totalVisitas,
    comResultado,
    semResultado,
    fechados,
    taxaConversao,
    fechadosComValor,
    fechadosSemValor,
    receitaTotal,
    ticketMedio,
  };
}
