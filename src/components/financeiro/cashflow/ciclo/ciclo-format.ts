// Formatação da aba Ciclo. Ausente ≠ zero: null/undefined sempre vira "—", nunca "R$ 0".
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';
import type { Company } from '@/contexts/CompanyContext';

export const brl = (v: number | null | undefined, frac = 0): string =>
  v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: frac });

export const dias = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v.toFixed(0)}d`);

export type PontoTendencia = { mes: string; concedido: number | null; real: number | null; pago: number | null; parcial: boolean };

export function montarSerieTendencia(coorte: CoorteMes[], company: Company): PontoTendencia[] {
  return coorte.filter((m) => m.company === company).map((m) => ({
    mes: m.mes.slice(0, 7) + (m.mesParcial ? '*' : ''),
    concedido: m.prazoConcedido,
    real: m.prazoReal,
    pago: m.pctValorPago === null ? null : Math.round(m.pctValorPago * 100),
    parcial: m.mesParcial,
  }));
}


export const ROTULO_PERFIL: Record<string, string> = {
  folga: 'Folga', pontual: 'Pontual', atraso_leve: 'Atraso leve', atraso_cronico: 'Atraso crônico', misto: 'Misto', sem_dado: 'Sem pagamento',
};
