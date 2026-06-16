// Cenários e cálculo do Teste de Estresse de caixa.
// Extraídos verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).

export interface StressScenario {
  label: string;
  delayDays: number;
  defaultPct: number;
  desc: string;
}

export const SCENARIOS: StressScenario[] = [
  { label: 'Base', delayDays: 0, defaultPct: 0, desc: 'Cenário atual sem alterações' },
  { label: 'Atraso 15d', delayDays: 15, defaultPct: 0, desc: 'Clientes atrasam 15 dias em média' },
  { label: 'Atraso 30d', delayDays: 30, defaultPct: 0, desc: 'Clientes atrasam 30 dias em média' },
  { label: '10% inadimplência', delayDays: 0, defaultPct: 10, desc: '10% dos recebíveis viram perda' },
  { label: '25% inadimplência', delayDays: 0, defaultPct: 25, desc: '25% dos recebíveis viram perda' },
  { label: 'Combinado severo', delayDays: 30, defaultPct: 15, desc: 'Atraso 30d + 15% inadimplência' },
];

export interface StressInputs {
  saldoCC: number;
  entradas30: number;
  saidas30: number;
  pmr: number;
}

export interface StressRow {
  entradasAjust: number;
  saldo: number;
  impacto: number;
  risco: string;
  riskColor: string;
}

export function computeStressRow(s: StressScenario, { saldoCC, entradas30, saidas30, pmr }: StressInputs): StressRow {
  // Se delay > 0, parte das entradas dos próx 30d escorrega pra fora
  const pctDelayed = s.delayDays > 0
    ? Math.min(s.delayDays / Math.max(pmr + s.delayDays, 1), 0.8)
    : 0;
  const entradasAjust = entradas30 * (1 - pctDelayed) * (1 - s.defaultPct / 100);
  const saldo = saldoCC + entradasAjust - saidas30;
  const impacto = saldo - (saldoCC + entradas30 - saidas30);
  const risco = saldo < 0 ? 'Crítico' : saldo < saldoCC * 0.3 ? 'Alto' : saldo < saldoCC * 0.6 ? 'Médio' : 'Baixo';
  const riskColor = risco === 'Crítico' ? 'text-status-error bg-status-error-bg'
    : risco === 'Alto' ? 'text-status-error bg-status-error-bg'
    : risco === 'Médio' ? 'text-status-warning bg-status-warning-bg'
    : 'text-status-success bg-status-success-bg';
  return { entradasAjust, saldo, impacto, risco, riskColor };
}
