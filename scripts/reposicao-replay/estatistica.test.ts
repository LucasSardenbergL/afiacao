import { describe, expect, it } from 'vitest';
import {
  avaliarCriterios,
  bootstrapPareado,
  clopperPearsonInferior,
  estatCusto,
  estatDeltaFillRate,
  estatFillRate,
  estatReducaoCapital,
  indicesBlocosCirculares,
  meiaLarguraMC,
  veredito,
  type Estado,
} from './estatistica';
import { custoLiquido } from './metricas';
import { CELULAS, type Celula, type SomasCelula, type SomasSemanais } from './simulador';
import type { Evidencia, EvidenciaServico, IntervaloPorBloco } from './tipos';

// Fixtures sintéticas (valores fictícios, só para casar as contas).
const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);
const celulaVazia = (n: number): SomasCelula => ({
  demandadas: zeros(n), integrais: zeros(n), unidDem: zeros(n), unidAt: zeros(n), valorDem: zeros(n), valorAt: zeros(n),
});
function somas(n: number, dias = 7): SomasSemanais {
  const porCelula = Object.fromEntries(CELULAS.map((c) => [c, celulaVazia(n)])) as Record<Celula, SomasCelula>;
  return {
    semanas: Array.from({ length: n }, (_, i) => `2026-05-${String(1 + 7 * (i % 4)).padStart(2, '0')}#${i}`),
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
/** Somas com demanda/atendimento variando por semana e por rep (para o bootstrap ter dispersão). */
function somasVariadas(n: number, rep: number): SomasSemanais {
  const s = somas(n);
  s.porCelula.A.demandadas = Array.from({ length: n }, (_, i) => 10 + ((i * 7 + rep * 3) % 5));
  s.porCelula.A.integrais = s.porCelula.A.demandadas.map((d, i) => d - ((i + rep) % 3));
  s.estoqueCmcDias = Array.from({ length: n }, (_, i) => 1000 + 37 * ((i + rep) % 6));
  return s;
}
const G = { taxa: 0.25, emergencialPerc: 0.1, atrasoPerc: 0.01 };

describe('indicesBlocosCirculares', () => {
  it('n índices, blocos contíguos circulares, determinístico pela chave', () => {
    const idx = indicesBlocosCirculares(10, 4, 7);
    expect(idx).toHaveLength(10);
    expect(idx).toEqual(indicesBlocosCirculares(10, 4, 7));
    for (let j = 0; j < 10; j += 4) {
      for (let k = 1; k < 4 && j + k < 10; k++) expect(idx[j + k]).toBe((idx[j] + k) % 10);
    }
    expect(indicesBlocosCirculares(10, 4, 8)).not.toEqual(idx);
  });
});

describe('bootstrapPareado', () => {
  it('políticas idênticas → LI = LS = 0 na diferença', () => {
    const base = [0, 1, 2].map((r) => somasVariadas(12, r));
    const alt = [0, 1, 2].map((r) => somasVariadas(12, r));
    for (const bloco of [4, 8] as const) {
      const r = bootstrapPareado(base, alt, estatDeltaFillRate('A'), bloco, 300);
      expect(r).toEqual({ ponto: 0, li: 0, ls: 0 });
    }
  });

  it('razão recalculada: semanas 1/1 e 90/100 → ponto 90,10%, não 95%', () => {
    const s = somas(2);
    s.porCelula.A.demandadas = [1, 100];
    s.porCelula.A.integrais = [1, 90];
    const r = bootstrapPareado([s], [s], estatFillRate('A'), 4, 200);
    expect(r.ponto).toBeCloseTo(91 / 101, 12);
    expect(r.ponto).not.toBeCloseTo(0.95, 3);
    expect(r.li).not.toBeNull();
    expect(r.li as number).toBeLessThanOrEqual(r.ponto as number);
    expect(r.ls as number).toBeGreaterThanOrEqual(r.ponto as number);
  });

  it('estatística agrega as replicações por SOMA (não média de razões por rep)', () => {
    const r0 = somas(1);
    r0.porCelula.A.demandadas = [1];
    r0.porCelula.A.integrais = [0];
    const r1 = somas(1);
    r1.porCelula.A.demandadas = [9];
    r1.porCelula.A.integrais = [9];
    expect(bootstrapPareado([r0, r1], [r0, r1], estatFillRate('A'), 4, 10).ponto).toBeCloseTo(0.9, 12);
  });

  it('determinístico e com dispersão real', () => {
    const base = [0, 1].map((r) => somasVariadas(20, r));
    const alt = [0, 1].map((r) => somasVariadas(20, r + 5));
    const a = bootstrapPareado(base, alt, estatDeltaFillRate('A'), 4, 400);
    expect(bootstrapPareado(base, alt, estatDeltaFillRate('A'), 4, 400)).toEqual(a);
    expect((a.ls as number) - (a.li as number)).toBeGreaterThan(0);
    expect(bootstrapPareado(base, alt, estatDeltaFillRate('A'), 8, 400)).not.toEqual(a);
  });

  it('reamostragem sem denominador → limites null (ausente ≠ zero), ponto preservado', () => {
    const s = somas(20);
    s.porCelula.B.demandadas[3] = 5;
    s.porCelula.B.integrais[3] = 5;
    const r = bootstrapPareado([s], [s], estatFillRate('B'), 4, 500);
    expect(r).toEqual({ ponto: 1, li: null, ls: null });
  });

  it('ponto null → tudo null', () => {
    const s = somas(4);
    expect(bootstrapPareado([s], [s], estatFillRate('C'), 4, 50)).toEqual({ ponto: null, li: null, ls: null });
  });

  it('reps desparelhadas → erro', () => {
    expect(() => bootstrapPareado([somas(4)], [somas(4), somas(4)], estatFillRate('A'), 4, 10)).toThrow(
      'ESTATISTICA_REPS_DESPAREADAS',
    );
    expect(() => bootstrapPareado([somas(4)], [somas(5)], estatFillRate('A'), 4, 10)).toThrow(
      'ESTATISTICA_REPS_DESPAREADAS',
    );
  });

  it('redução de capital recalculada sobre as somas', () => {
    const b = somas(2);
    b.estoqueCmcDias = [700, 2100];
    const a = somas(2);
    a.estoqueCmcDias = [700, 1400];
    expect(bootstrapPareado([b], [a], estatReducaoCapital, 4, 10).ponto).toBeCloseTo(1 - 2100 / 2800, 12);
  });

  it('custo: média das reps de custoLiquido(.custo); terminal entra uma vez', () => {
    const b = [somas(3), somas(3)];
    const a = [somas(3), somas(3)];
    b[0].estoqueCmcDias = [7000, 7000, 7000];
    b[1].estoqueCmcDias = [14000, 14000, 14000];
    a[1].terminal.backlogValor = 100;
    const esperado =
      ((custoLiquido(b[0], a[0], G).custo as number) + (custoLiquido(b[1], a[1], G).custo as number)) / 2;
    expect(estatCusto(G)(b, a, [0, 1, 2])).toBeCloseTo(esperado, 9);
    // idx repetido: o terminal (−10 em a[1]) não é multiplicado
    const so0 = estatCusto(G)(b, a, [0, 0, 0]) as number;
    expect(so0).toBeCloseTo(((1000 * 0.25 * 21) / 365 + (2000 * 0.25 * 21) / 365 - 10) / 2, 9);
  });
});

describe('clopperPearsonInferior', () => {
  it('zero falhas com 100 linhas ≈ 97,05% (0,05^(1/100))', () => {
    expect(clopperPearsonInferior(100, 100)).toBeCloseTo(Math.pow(0.05, 1 / 100), 6);
    expect(clopperPearsonInferior(100, 100)).toBeLessThan(0.98);
  });
  it('5/10 → 0,2224 (unilateral 95%)', () => {
    expect(clopperPearsonInferior(5, 10)).toBeCloseTo(0.22244, 4);
  });
  it('0 sucessos → 0; n inválido → erro', () => {
    expect(clopperPearsonInferior(0, 50)).toBe(0);
    expect(() => clopperPearsonInferior(1, 0)).toThrow('CLOPPER_PEARSON_N_INVALIDO');
    expect(() => clopperPearsonInferior(11, 10)).toThrow('CLOPPER_PEARSON_N_INVALIDO');
  });
});

describe('meiaLarguraMC', () => {
  it('1,96 × desvio amostral ÷ √n', () => {
    const sd = Math.sqrt(((1.5 ** 2 + 0.5 ** 2) * 2) / 3);
    expect(meiaLarguraMC([1, 2, 3, 4])).toBeCloseTo((1.96 * sd) / 2, 12);
  });
  it('menos de 2 reps → Infinity (sem precisão estimável)', () => {
    expect(meiaLarguraMC([5])).toBe(Infinity);
  });
});

// ── tabela de decisão ──────────────────────────────────────────────────────────────────────────────────
const iv = (ponto: number | null, li: number | null, ls: number | null): IntervaloPorBloco => ({
  4: { ponto, li, ls },
  8: { ponto, li, ls },
});
const CEL6: Celula[] = ['A', 'B', 'C', 'A_alt', 'B_alt', 'C_alt'];
const servicoOk = (falta: 'espera' | 'cancelamento'): EvidenciaServico => ({
  falta,
  pisos: (['A', 'B', 'C'] as const).map((classe) => ({
    classe,
    fill: iv(0.995, 0.993, 0.997),
    atendidas: 4975,
    demandadas: 5000,
  })),
  naoInferioridade: CEL6.map((celula) => ({ celula, delta: iv(0, -0.002, 0.002) })),
});
const FALTAS3 = ['espera', 'cancelamento', 'misto'] as const;
function evidenciaGo(): Evidencia {
  const grade = [];
  for (const falta of ['espera', 'cancelamento', 'misto'] as const) {
    for (const emergencialPerc of [0.05, 0.1, 0.2]) {
      for (const atrasoPerc of [0, 0.005, 0.01]) {
        grade.push({
          falta,
          grade: { taxa: 0.25, emergencialPerc, atrasoPerc },
          custo: iv(500, 100, 900),
          linhasMargemLimitada: 3,
          valorMargemLimitada: 50,
          linhasDemandadas: 5000,
          valorDemandado: 100000,
        });
      }
    }
  }
  return {
    servico: [servicoOk('espera'), servicoOk('cancelamento')],
    capital: FALTAS3.map((falta) => ({ falta, reducao: iv(0.2, 0.15, 0.25) })),
    estresse: {
      servico: [servicoOk('espera'), servicoOk('cancelamento')],
      capital: FALTAS3.map((falta) => ({ falta, reducao: iv(0.1, 0.05, 0.15) })),
    },
    economia: grade,
    exposicao: CEL6.map((celula) => ({ celula, linhas: 5000 })),
    precisao: {
      replicacoes: 200,
      teto: 1000,
      meiaLarguraServico: 0.0005,
      alvoServico: 0.001,
      meiaLarguraEstoque: 0.005,
      alvoEstoque: 0.01,
    },
    estadosIniciais: [
      { rotulo: 'reconstruido', veredito: 'GO' },
      { rotulo: 'piso_zero', veredito: 'GO' },
    ],
  };
}
const estadoDe = (ev: Evidencia, criterio: string): Estado | undefined =>
  avaliarCriterios(ev).find((c) => c.criterio === criterio)?.estado;

describe('avaliarCriterios + veredito', () => {
  it('evidência toda dentro → GO, todas PASSA', () => {
    const cs = avaliarCriterios(evidenciaGo());
    expect(cs.every((c) => c.estado === 'PASSA')).toBe(true);
    expect(veredito(cs).veredito).toBe('GO');
  });

  it('zero falhas com 100 linhas não passa piso A (Clopper-Pearson ≈ 97,05%)', () => {
    const ev = evidenciaGo();
    ev.servico[0].pisos[0] = { classe: 'A', fill: iv(1, 0.99, 1), atendidas: 100, demandadas: 100 };
    expect(estadoDe(ev, '1 Piso A [espera]')).toBe('INCERTO');
    expect(veredito(avaliarCriterios(ev)).veredito).toBe('INCONCLUSIVO');
  });

  it('piso: LS < piso → FALHA; linhas null → INCERTO', () => {
    const ev = evidenciaGo();
    ev.servico[1].pisos[1] = { classe: 'B', fill: iv(0.93, 0.92, 0.949), atendidas: 4650, demandadas: 5000 };
    expect(estadoDe(ev, '1 Piso B [cancelamento]')).toBe('FALHA');
    const ev2 = evidenciaGo();
    ev2.servico[0].pisos[2].demandadas = null;
    expect(estadoDe(ev2, '1 Piso C [espera]')).toBe('INCERTO');
  });

  it('capital 9% em [8%, 11%] → INCERTO; LS < 10% → FALHA', () => {
    const ev = evidenciaGo();
    ev.capital[0].reducao = iv(0.09, 0.08, 0.11);
    expect(estadoDe(ev, '3 Capital [espera]')).toBe('INCERTO');
    ev.capital[0].reducao = iv(0.08, 0.06, 0.099);
    expect(estadoDe(ev, '3 Capital [espera]')).toBe('FALHA');
    expect(veredito(avaliarCriterios(ev)).veredito).toBe('NO-GO');
  });

  it('A-alterados com −2 p.p. e LS abaixo → NO-GO mesmo com A total passando', () => {
    const ev = evidenciaGo();
    ev.servico[0].naoInferioridade[3] = { celula: 'A_alt', delta: iv(-0.02, -0.03, -0.01) };
    expect(estadoDe(ev, '2 Não inferioridade A [espera]')).toBe('PASSA');
    expect(estadoDe(ev, '2 Não inferioridade A_alt [espera]')).toBe('FALHA');
    const v = veredito(avaliarCriterios(ev));
    expect(v.veredito).toBe('NO-GO');
    expect(v.motivos.some((m) => m.startsWith('2 Não inferioridade A_alt [espera]'))).toBe(true);
  });

  it('LI = min(LI4, LI8) e LS = max(LS4, LS8): desacordo entre blocos é incerteza, nunca refutação', () => {
    const ev = evidenciaGo();
    ev.capital[0].reducao = { 4: { ponto: 0.12, li: 0.06, ls: 0.2 }, 8: { ponto: 0.12, li: 0.04, ls: 0.2 } };
    expect(estadoDe(ev, '3 Capital [espera]')).toBe('INCERTO');
    ev.servico[0].naoInferioridade[0] = {
      celula: 'A',
      delta: { 4: { ponto: -0.008, li: -0.012, ls: -0.006 }, 8: { ponto: -0.008, li: -0.012, ls: -0.004 } },
    };
    expect(estadoDe(ev, '2 Não inferioridade A [espera]')).toBe('INCERTO');
  });

  it('célula com 299 linhas → INCERTO', () => {
    const ev = evidenciaGo();
    ev.exposicao[4] = { celula: 'B_alt', linhas: 299 };
    expect(estadoDe(ev, 'Exposição B_alt')).toBe('INCERTO');
    expect(veredito(avaliarCriterios(ev)).veredito).toBe('INCONCLUSIVO');
    ev.exposicao[4] = { celula: 'B_alt', linhas: 300 };
    expect(estadoDe(ev, 'Exposição B_alt')).toBe('PASSA');
    ev.exposicao.splice(4, 1);
    expect(estadoDe(ev, 'Exposição B_alt')).toBe('INCERTO');
  });

  it('custo com LS < 0 numa célula da grade → NO-GO', () => {
    const ev = evidenciaGo();
    ev.economia[13].custo = iv(-50, -120, -10);
    const v = veredito(avaliarCriterios(ev));
    expect(v.veredito).toBe('NO-GO');
    expect(v.motivos.some((m) => m.startsWith('5 Economia [cancelamento'))).toBe(true);
  });

  it('economia: motivo mostra o limite de margem em %, sem R$ absoluto', () => {
    const cs = avaliarCriterios(evidenciaGo()).filter((c) => c.criterio.startsWith('5 Economia'));
    expect(cs).toHaveLength(27);
    expect(cs[0].motivo).toContain('0,06% das linhas');
    expect(cs[0].motivo).toContain('0,05% do valor');
    expect(cs[0].motivo).not.toContain('500');
  });

  it('cenário de falta obrigatório ausente → INCERTO', () => {
    const ev = evidenciaGo();
    ev.servico.pop();
    expect(estadoDe(ev, '1-2 Serviço [cancelamento]')).toBe('INCERTO');
    const ev2 = evidenciaGo();
    ev2.economia = ev2.economia.filter((e) => e.falta !== 'misto');
    expect(estadoDe(ev2, '5 Economia [misto]')).toBe('INCERTO');
    expect(veredito(avaliarCriterios(ev2)).veredito).toBe('INCONCLUSIVO');
  });

  it('estresse: LS(redução) ≤ 0 → FALHA; serviço em FALHA → FALHA', () => {
    const ev = evidenciaGo();
    ev.estresse.capital[0].reducao = iv(-0.01, -0.05, 0);
    expect(estadoDe(ev, '4 Estresse [espera]')).toBe('FALHA');
    const ev2 = evidenciaGo();
    ev2.estresse.servico[1].naoInferioridade[0] = { celula: 'A', delta: iv(-0.02, -0.03, -0.01) };
    expect(estadoDe(ev2, '4 Estresse 2 Não inferioridade A [cancelamento]')).toBe('FALHA');
    expect(veredito(avaliarCriterios(ev2)).veredito).toBe('NO-GO');
  });

  it('cenário de capital ausente → INCERTO (R25: espera, cancelamento e misto obrigatórios)', () => {
    const ev = evidenciaGo();
    ev.capital = ev.capital.filter((c) => c.falta !== 'misto');
    expect(estadoDe(ev, '3 Capital [misto]')).toBe('INCERTO');
    expect(veredito(avaliarCriterios(ev)).veredito).toBe('INCONCLUSIVO');
    const ev2 = evidenciaGo();
    ev2.estresse.capital = ev2.estresse.capital.filter((c) => c.falta !== 'cancelamento');
    expect(estadoDe(ev2, '4 Estresse [cancelamento]')).toBe('INCERTO');
    expect(veredito(avaliarCriterios(ev2)).veredito).toBe('INCONCLUSIVO');
    const ev3 = evidenciaGo();
    ev3.capital = [];
    expect(estadoDe(ev3, '3 Capital [espera]')).toBe('INCERTO');
  });

  it('capital: FALHA em qualquer cenário → NO-GO', () => {
    const ev = evidenciaGo();
    ev.capital[2].reducao = iv(0.05, 0.02, 0.08);
    expect(estadoDe(ev, '3 Capital [misto]')).toBe('FALHA');
    expect(veredito(avaliarCriterios(ev)).veredito).toBe('NO-GO');
  });

  it('veredito diverge entre estados iniciais → INCONCLUSIVO', () => {
    const ev = evidenciaGo();
    ev.estadosIniciais = [
      { rotulo: 'reconstruido', veredito: 'GO' },
      { rotulo: 'piso_zero', veredito: 'INCONCLUSIVO' },
    ];
    expect(estadoDe(ev, 'Estado inicial')).toBe('INCERTO');
    expect(veredito(avaliarCriterios(ev)).veredito).toBe('INCONCLUSIVO');
    ev.estadosIniciais = null;
    expect(estadoDe(ev, 'Estado inicial')).toBe('INCERTO');
  });

  it('teto de replicações sem precisão → INCONCLUSIVO', () => {
    const ev = evidenciaGo();
    ev.precisao = { ...ev.precisao, replicacoes: 1000, meiaLarguraServico: 0.0015 };
    expect(estadoDe(ev, 'Precisão')).toBe('INCERTO');
    expect(veredito(avaliarCriterios(ev)).veredito).toBe('INCONCLUSIVO');
    ev.precisao = { ...ev.precisao, meiaLarguraServico: 0.0005, meiaLarguraEstoque: null };
    expect(estadoDe(ev, 'Precisão')).toBe('INCERTO');
  });

  it('veredito: FALHA vence INCERTO; null ou lista vazia → INCONCLUSIVO', () => {
    expect(
      veredito([
        { criterio: 'x', estado: 'INCERTO', motivo: '' },
        { criterio: 'y', estado: 'FALHA', motivo: 'm' },
      ]),
    ).toEqual({ veredito: 'NO-GO', motivos: ['y: m'] });
    expect(veredito([{ criterio: 'x', estado: null, motivo: 'sem dado' }]).veredito).toBe('INCONCLUSIVO');
    expect(veredito([]).veredito).toBe('INCONCLUSIVO');
  });
});
