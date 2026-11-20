import { describe, expect, it } from 'vitest';
import {
  caixaDoEscopo,
  empresasDoEscopo,
  linhasPorEmpresa,
  margemUltimoMesFechado,
  ncgDoEscopo,
  vencidosDoEscopo,
  type DreLinha,
  type ResumoCnpj,
} from '../ceo-placar';

const r = (saldo: number | null, receber: number | null, vencido: number | null, pagar = 0): ResumoCnpj => ({
  saldo_total_cc: saldo,
  total_a_receber: receber,
  total_a_pagar: pagar,
  total_vencido_receber: vencido,
  total_vencido_pagar: 0,
  posicao_liquida: receber === null ? null : receber - pagar,
  titulos_motivo: receber === null ? 'sem_acesso' : null,
});

const RESUMO: Record<string, ResumoCnpj> = {
  oben: r(100, 1000, 100, 400),
  colacor: r(50, 500, 50, 100),
  colacor_sc: r(10, 0, 0),
};

const dre = (company: string, mes: number, receita: number, lucro: number): DreLinha => ({
  company,
  mes,
  receita_liquida: receita,
  lucro_bruto: lucro,
});

describe('empresasDoEscopo', () => {
  it('all = as 3 empresas; uma empresa = só ela', () => {
    expect(empresasDoEscopo('all')).toEqual(['oben', 'colacor', 'colacor_sc']);
    expect(empresasDoEscopo('oben')).toEqual(['oben']);
  });
});

describe('caixaDoEscopo', () => {
  it('soma o saldo e a posição líquida do escopo', () => {
    expect(caixaDoEscopo(RESUMO, ['oben', 'colacor', 'colacor_sc'])).toEqual({ saldo: 160, posicaoLiquida: 1000 });
    expect(caixaDoEscopo(RESUMO, ['colacor'])).toEqual({ saldo: 50, posicaoLiquida: 400 });
  });

  it('ausente ≠ zero: um CNPJ sem saldo anula o saldo do grupo', () => {
    const resumo = { ...RESUMO, colacor_sc: r(null, 0, 0) };
    expect(caixaDoEscopo(resumo, ['oben', 'colacor', 'colacor_sc']).saldo).toBeNull();
    expect(caixaDoEscopo(resumo, ['oben']).saldo).toBe(100);
  });

  it('CNPJ fora do resumo ou resumo nulo → null', () => {
    const { colacor_sc: _fora, ...resumo } = RESUMO;
    expect(caixaDoEscopo(resumo, ['oben', 'colacor_sc'])).toEqual({ saldo: null, posicaoLiquida: null });
    expect(caixaDoEscopo(null, ['oben'])).toEqual({ saldo: null, posicaoLiquida: null });
  });
});

describe('vencidosDoEscopo', () => {
  it('valor e percentual da carteira aberta', () => {
    expect(vencidosDoEscopo(RESUMO, ['oben', 'colacor', 'colacor_sc'])).toEqual({ valor: 150, pct: 0.1 });
  });

  it('carteira aberta zero é zero legítimo', () => {
    expect(vencidosDoEscopo(RESUMO, ['colacor_sc'])).toEqual({ valor: 0, pct: 0 });
  });

  it('títulos indisponíveis em um CNPJ → null no agregado', () => {
    const resumo = { ...RESUMO, colacor: r(50, null, null) };
    expect(vencidosDoEscopo(resumo, ['oben', 'colacor'])).toEqual({ valor: null, pct: null });
  });
});

describe('margemUltimoMesFechado', () => {
  const DRE = [
    dre('oben', 9, 1000, 300),
    dre('oben', 10, 1000, 250),
    dre('oben', 11, 400, 200), // mês corrente, parcial: não conta
    dre('colacor', 9, 500, 100),
    dre('colacor', 10, 0, 0), // DRE vazia: não é mês fechado
  ];

  it('usa o último mês fechado COMUM a todas as empresas do escopo', () => {
    expect(margemUltimoMesFechado(DRE, ['oben', 'colacor'], 11)).toEqual({ valor: 400 / 1500, mes: 9 });
  });

  it('empresa sozinha usa o próprio último mês fechado, nunca o corrente', () => {
    expect(margemUltimoMesFechado(DRE, ['oben'], 11)).toEqual({ valor: 0.25, mes: 10 });
  });

  it('sem mês comum ou sem DRE → null (nunca 0%)', () => {
    expect(margemUltimoMesFechado(DRE, ['oben', 'colacor_sc'], 11)).toEqual({ valor: null, mes: null });
    expect(margemUltimoMesFechado(null, ['oben'], 11)).toEqual({ valor: null, mes: null });
    expect(margemUltimoMesFechado(DRE, ['oben'], 1)).toEqual({ valor: null, mes: null });
  });
});

describe('ncgDoEscopo', () => {
  const FONTE = {
    data_referencia: '2026-11-19',
    ncg_por_empresa: [
      { company: 'oben', ncg: 300, presente: true },
      { company: 'colacor', ncg: 200, presente: true },
      { company: 'colacor_sc', ncg: null, presente: false },
    ],
  };

  it('soma os CNPJs presentes do escopo', () => {
    expect(ncgDoEscopo(FONTE, ['oben', 'colacor'])).toEqual({ valor: 500, dataReferencia: '2026-11-19' });
  });

  it('um CNPJ ausente anula o grupo', () => {
    expect(ncgDoEscopo(FONTE, ['oben', 'colacor', 'colacor_sc']).valor).toBeNull();
    expect(ncgDoEscopo(null, ['oben']).valor).toBeNull();
  });
});

describe('linhasPorEmpresa', () => {
  it('uma linha por CNPJ, cada uma com a própria régua', () => {
    const linhas = linhasPorEmpresa(RESUMO, [dre('oben', 10, 1000, 250)], null, ['oben', 'colacor'], 11);
    expect(linhas.map((l) => l.empresa)).toEqual(['oben', 'colacor']);
    expect(linhas[0].margem).toEqual({ valor: 0.25, mes: 10 });
    expect(linhas[1].margem).toEqual({ valor: null, mes: null });
    expect(linhas[1].caixa.saldo).toBe(50);
  });
});
