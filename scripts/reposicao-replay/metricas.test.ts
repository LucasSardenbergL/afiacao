import { describe, expect, it } from 'vitest';
import { custoFaltaEquilibrio, custoLiquido, dioSayerlack, estoqueMedio, fillRate } from './metricas';
import { CELULAS, type Celula, type SomasCelula, type SomasSemanais } from './simulador';

// Fixtures sintéticas (valores em R$ fictícios, só para casar as contas).
const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);
const celulaVazia = (n: number): SomasCelula => ({
  demandadas: zeros(n), integrais: zeros(n), unidDem: zeros(n), unidAt: zeros(n), valorDem: zeros(n), valorAt: zeros(n),
});
function somas(n: number, dias = 7): SomasSemanais {
  const porCelula = Object.fromEntries(CELULAS.map((c) => [c, celulaVazia(n)])) as Record<Celula, SomasCelula>;
  return {
    semanas: Array.from({ length: n }, (_, i) => `2026-05-${String(1 + 7 * i).padStart(2, '0')}`),
    porCelula,
    estoqueCmcDias: zeros(n),
    diasCorridos: Array.from({ length: n }, () => dias),
    entregue: { imediata: zeros(n), tardia: zeros(n), emergencial: zeros(n) },
    cancelada: { valor: zeros(n), margem: zeros(n) },
    canceladaSemCmc: { linhas: zeros(n), valor: zeros(n) },
    valorDiasAtraso: zeros(n),
    terminal: { estoqueCmc: 0, abertasCmc: 0, backlogValor: 0, backlogDiasAtraso: 0 },
    balanco: { inicial: 0, recebido: 0, entregue: 0, final: 0 },
    skusSemCmc: [],
    excluidos: [],
    linhasIgnoradas: 0,
  };
}
const G = { taxa: 0.25, emergencialPerc: 0.1, atrasoPerc: 0.01 };

describe('fillRate', () => {
  it('fill rate é soma, não média', () => {
    const s = somas(2);
    s.porCelula.A.demandadas = [1, 9];
    s.porCelula.A.integrais = [1, 0];
    expect(fillRate(s, 'A')).toBeCloseTo(0.1, 12); // média de razões daria 50%
    expect(fillRate(s, 'A', [0])).toBe(1);
    expect(fillRate(s, 'A', [1, 1])).toBe(0);
  });
  it('célula sem linha → null', () => {
    const s = somas(2);
    expect(fillRate(s, 'B_alt')).toBeNull();
  });
});

describe('estoqueMedio / dioSayerlack', () => {
  it('ponderado pelos dias corridos (semana parcial pesa menos)', () => {
    const s = somas(2);
    s.diasCorridos = [7, 1];
    s.estoqueCmcDias = [7 * 100, 1 * 900];
    expect(estoqueMedio(s)).toBeCloseTo(1600 / 8, 12);
    expect(dioSayerlack(s, 10)).toBeCloseTo(20, 12);
  });
  it('sem dias corridos ou CMV não positivo → erro, nunca número fabricado', () => {
    const s = somas(1);
    expect(() => estoqueMedio(s, [])).toThrow(/sem dias corridos/);
    expect(() => dioSayerlack(s, 0)).toThrow(/CMV Sayerlack/);
  });
});

describe('custoLiquido', () => {
  it('valor × dias por linha: R$ 1.000 × 1 d + R$ 10 × 10 d a 1% → R$ 11', () => {
    const base = somas(1);
    const alt = somas(1);
    alt.valorDiasAtraso = [1000 * 1 + 10 * 10];
    expect(custoLiquido(base, alt, { taxa: 0.25, emergencialPerc: 0.1, atrasoPerc: 0.01 }).custo).toBeCloseTo(-11, 9);
  });
  it('R$ 20k liberados a 25% em 365 d, sem falta → R$ 5k', () => {
    const base = somas(1, 365);
    const alt = somas(1, 365);
    base.estoqueCmcDias = [50_000 * 365];
    alt.estoqueCmcDias = [30_000 * 365];
    expect(custoLiquido(base, alt, G).custo).toBeCloseTo(5000, 6);
  });
  it('políticas iguais → custo 0', () => {
    const base = somas(3);
    base.estoqueCmcDias = [700, 800, 900];
    base.entregue.emergencial = [10, 0, 5];
    base.valorDiasAtraso = [3, 4, 5];
    base.cancelada = { valor: [100, 0, 0], margem: [30, 0, 0] };
    base.terminal = { estoqueCmc: 1, abertasCmc: 2, backlogValor: 50, backlogDiasAtraso: 500 };
    const alt = structuredClone(base);
    expect(custoLiquido(base, alt, G)).toEqual({ custo: 0, linhasMargemLimitada: 0, valorMargemLimitada: 0 });
  });
  it('emergencial, margem cancelada e terminal entram como Δ (alt − base)', () => {
    const base = somas(1);
    const alt = somas(1);
    alt.entregue.emergencial = [1000]; // 1000 × 10% = 100
    alt.cancelada = { valor: [500], margem: [200] }; // 200
    alt.terminal = { estoqueCmc: 0, abertasCmc: 0, backlogValor: 300, backlogDiasAtraso: 2000 }; // 30 + 20
    expect(custoLiquido(base, alt, G).custo).toBeCloseTo(-350, 9);
  });
  it('sem cmc só no ALT: margem = valor (pior caso para a alternativa) e conta as linhas limitadas', () => {
    const base = somas(2);
    const alt = somas(2);
    // semana 0 mista (margem conhecida 100 + 1 linha sem cmc de 200); semana 1 toda sem cmc (margem null, 2 linhas, 400)
    alt.cancelada = { valor: [500, 400], margem: [100, null] };
    alt.canceladaSemCmc = { linhas: [1, 2], valor: [200, 400] };
    const r = custoLiquido(base, alt, G);
    expect(r.custo).toBeCloseTo(-(100 + 200 + 0 + 400), 9); // alt perde a margem máxima possível
    expect(r.linhasMargemLimitada).toBe(3);
    expect(r.valorMargemLimitada).toBe(600);
    expect(custoLiquido(base, alt, G, [0]).custo).toBeCloseTo(-300, 9); // idx restringe o limite também
  });
  it('sem cmc só na BASE: margem = 0 (a base não ganha crédito pela perda desconhecida)', () => {
    const base = somas(1);
    const alt = somas(1);
    base.cancelada = { valor: [700], margem: [null] };
    base.canceladaSemCmc = { linhas: [3], valor: [700] };
    const r = custoLiquido(base, alt, G);
    expect(r.custo).toBe(0); // se a base contasse margem = valor, a alt ganharia +700 fabricado
    expect(r.linhasMargemLimitada).toBe(3);
    expect(r.valorMargemLimitada).toBe(700);
  });
  it('null só por falta de dado de capital (janela sem dias corridos)', () => {
    const base = somas(1, 0);
    expect(custoLiquido(base, structuredClone(base), G).custo).toBeNull();
  });
  it('braços não pareados → erro', () => {
    expect(() => custoLiquido(somas(2), somas(3), G)).toThrow(/pareados/);
  });
});

describe('custoFaltaEquilibrio', () => {
  it('capital evitado ÷ faltas adicionais (linhas, célula total)', () => {
    const base = somas(1, 365);
    const alt = somas(1, 365);
    base.estoqueCmcDias = [50_000 * 365];
    alt.estoqueCmcDias = [30_000 * 365];
    base.porCelula.total.demandadas = [100];
    base.porCelula.total.integrais = [99];
    alt.porCelula.total.demandadas = [100];
    alt.porCelula.total.integrais = [94];
    expect(custoFaltaEquilibrio(base, alt, 0.25)).toBeCloseTo(1000, 6); // 5k ÷ 5 faltas
  });
  it('sem falta adicional → null (não há equilíbrio a medir)', () => {
    const base = somas(1);
    base.porCelula.total.demandadas = [10];
    base.porCelula.total.integrais = [9];
    expect(custoFaltaEquilibrio(base, structuredClone(base), 0.25)).toBeNull();
  });
});
