/**
 * Helpers de formatação e expansão pro módulo de cashflow.
 * Todos timezone-agnostic (operam em ISO strings YYYY-MM-DD).
 */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatSemana(isoDate: string): string {
  const [, mm, dd] = isoDate.split('-');
  return `${dd}/${mm}`;
}

export function formatBRL(value: number): string {
  return BRL.format(value);
}

export function formatDelta(value: number): string {
  if (value === 0) return formatBRL(0);
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatBRL(value)}`;
}

/**
 * Segunda-feira da semana ISO da data informada.
 * ISO weeks start on Monday.
 */
export function inicioSemana(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=domingo, 1=segunda, ..., 6=sábado
  const diff = day === 0 ? -6 : 1 - day; // dom→-6, seg→0, ter→-1, ...
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

type Recorrente = { dia_do_mes: number; inicio: string; fim: string | null };
type Janela = { de: string; ate: string };

function ultimoDiaMes(ano: number, mes1: number): number {
  // mes1 = 1..12
  return new Date(Date.UTC(ano, mes1, 0)).getUTCDate();
}

export function expandirRecorrente(rec: Recorrente, janela: Janela): string[] {
  const result: string[] = [];
  const start = new Date((rec.inicio > janela.de ? rec.inicio : janela.de) + 'T00:00:00Z');
  const end = new Date(janela.ate + 'T00:00:00Z');
  const fim = rec.fim ? new Date(rec.fim + 'T00:00:00Z') : null;

  let ano = start.getUTCFullYear();
  let mes1 = start.getUTCMonth() + 1; // 1..12

  while (true) {
    const dia = Math.min(rec.dia_do_mes, ultimoDiaMes(ano, mes1));
    const candidato = new Date(Date.UTC(ano, mes1 - 1, dia));
    if (candidato > end) break;
    if (candidato >= start && (!fim || candidato <= fim)) {
      result.push(candidato.toISOString().slice(0, 10));
    }
    mes1++;
    if (mes1 > 12) { mes1 = 1; ano++; }
  }

  return result;
}
