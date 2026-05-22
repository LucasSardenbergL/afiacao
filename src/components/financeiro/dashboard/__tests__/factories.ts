import type { FinDRE, FluxoCaixaDiario } from '@/services/financeiroService';

export function makeDRE(overrides: Partial<FinDRE> = {}): FinDRE {
  return {
    company: 'oben',
    ano: 2026,
    mes: 1,
    regime: 'caixa',
    receita_bruta: 0,
    deducoes: 0,
    receita_liquida: 0,
    cmv: 0,
    lucro_bruto: 0,
    despesas_operacionais: 0,
    despesas_administrativas: 0,
    despesas_comerciais: 0,
    despesas_financeiras: 0,
    receitas_financeiras: 0,
    resultado_operacional: 0,
    outras_receitas: 0,
    outras_despesas: 0,
    resultado_antes_impostos: 0,
    impostos: 0,
    resultado_liquido: 0,
    detalhamento: { receitas: {}, despesas: {} },
    ...overrides,
  };
}

export function makeFluxoDia(overrides: Partial<FluxoCaixaDiario> = {}): FluxoCaixaDiario {
  return {
    data: '2026-01-01',
    entradas_previstas: 0,
    entradas_realizadas: 0,
    saidas_previstas: 0,
    saidas_realizadas: 0,
    saldo_previsto: 0,
    saldo_realizado: 0,
    ...overrides,
  };
}
