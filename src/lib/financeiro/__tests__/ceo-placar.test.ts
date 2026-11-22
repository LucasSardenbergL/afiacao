import { describe, expect, it } from 'vitest';
import {
  caixaDoEscopo,
  caixaProjetadoDoEscopo,
  cobrancaDoEscopo,
  composicaoMargem,
  devedorDaFila,
  empresasDoEscopo,
  linhasPorEmpresa,
  margemUltimoMesFechado,
  ncgDoEscopo,
  vencidosDoEscopo,
  type DreLinha,
  type ResumoCnpj,
} from '../ceo-placar';
import type { SnapshotEmpresa } from '../cockpit-consolida-helpers';

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
  cmv: receita - lucro,
});

describe('empresasDoEscopo', () => {
  it('all = as 3 empresas; uma empresa = só ela', () => {
    expect(empresasDoEscopo('all')).toEqual(['oben', 'colacor', 'colacor_sc']);
    expect(empresasDoEscopo('oben')).toEqual(['oben']);
  });
});

describe('caixaDoEscopo', () => {
  it('soma o saldo e a posição líquida do escopo', () => {
    expect(caixaDoEscopo(RESUMO, ['oben', 'colacor', 'colacor_sc'])).toEqual({ saldo: 160, posicaoLiquida: 1000, empresasNegativas: [] });
    expect(caixaDoEscopo(RESUMO, ['colacor'])).toEqual({ saldo: 50, posicaoLiquida: 400, empresasNegativas: [] });
  });

  it('ausente ≠ zero: um CNPJ sem saldo anula o saldo do grupo', () => {
    const resumo = { ...RESUMO, colacor_sc: r(null, 0, 0) };
    expect(caixaDoEscopo(resumo, ['oben', 'colacor', 'colacor_sc']).saldo).toBeNull();
    expect(caixaDoEscopo(resumo, ['oben']).saldo).toBe(100);
  });

  it('lista os CNPJs com saldo negativo que o total compensa (caixa não é fungível)', () => {
    const resumo = { ...RESUMO, colacor: r(-327, 500, 50), colacor_sc: r(-203, 0, 0) };
    const c = caixaDoEscopo(resumo, ['oben', 'colacor', 'colacor_sc']);
    expect(c.saldo).toBe(100 - 327 - 203);
    expect(c.empresasNegativas).toEqual(['colacor', 'colacor_sc']);
  });

  it('CNPJ fora do resumo ou resumo nulo → null', () => {
    const { colacor_sc: _fora, ...resumo } = RESUMO;
    expect(caixaDoEscopo(resumo, ['oben', 'colacor_sc'])).toEqual({ saldo: null, posicaoLiquida: null, empresasNegativas: [] });
    expect(caixaDoEscopo(null, ['oben'])).toEqual({ saldo: null, posicaoLiquida: null, empresasNegativas: [] });
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
    expect(margemUltimoMesFechado(DRE, ['oben', 'colacor'], 11)).toEqual({ valor: 400 / 1500, mes: 9, semCmv: [], servicoFora: [] });
  });

  it('empresa sozinha usa o próprio último mês fechado, nunca o corrente', () => {
    expect(margemUltimoMesFechado(DRE, ['oben'], 11)).toEqual({ valor: 0.25, mes: 10, semCmv: [], servicoFora: [] });
  });

  it('empresa de serviço (Colacor SC) sai da margem bruta — nunca 100%, nunca derruba o grupo', () => {
    const sc: DreLinha = { company: 'colacor_sc', mes: 10, receita_liquida: 800, lucro_bruto: 800, cmv: 0 };
    const base = [dre('oben', 10, 1000, 250), dre('colacor', 10, 500, 200)];
    expect(margemUltimoMesFechado([...base, sc], ['oben', 'colacor', 'colacor_sc'], 11))
      .toEqual({ valor: 450 / 1500, mes: 10, semCmv: [], servicoFora: ['colacor_sc'] });
    // SC sem DRE no mês também não trava o mês comum do grupo.
    expect(margemUltimoMesFechado(base, ['oben', 'colacor', 'colacor_sc'], 11))
      .toEqual({ valor: 450 / 1500, mes: 10, semCmv: [], servicoFora: ['colacor_sc'] });
    expect(margemUltimoMesFechado([...base, sc], ['colacor_sc'], 11))
      .toEqual({ valor: null, mes: null, semCmv: [], servicoFora: ['colacor_sc'] });
  });

  it('empresa de mercadoria com CMV zerado/ausente é custo não classificado, nunca margem de 100%', () => {
    const semCusto: DreLinha = { company: 'colacor', mes: 10, receita_liquida: 500, lucro_bruto: 500, cmv: 0 };
    const nulo: DreLinha = { ...semCusto, cmv: null };
    const base = [dre('oben', 10, 1000, 250)];
    for (const linha of [semCusto, nulo]) {
      expect(margemUltimoMesFechado([...base, linha], ['oben', 'colacor', 'colacor_sc'], 11))
        .toEqual({ valor: null, mes: 10, semCmv: ['colacor'], servicoFora: ['colacor_sc'] });
      expect(margemUltimoMesFechado([...base, linha], ['colacor'], 11))
        .toEqual({ valor: null, mes: 10, semCmv: ['colacor'], servicoFora: [] });
    }
    // Controle: com custo classificado a mesma linha vira margem normal.
    expect(margemUltimoMesFechado([...base, { ...semCusto, lucro_bruto: 200, cmv: 300 }], ['oben', 'colacor'], 11))
      .toEqual({ valor: 450 / 1500, mes: 10, semCmv: [], servicoFora: [] });
  });

  it('sem mês comum ou sem DRE → null (nunca 0%)', () => {
    const vazio = { valor: null, mes: null, semCmv: [], servicoFora: [] };
    expect(margemUltimoMesFechado(DRE, ['oben', 'colacor'], 9)).toEqual(vazio);
    expect(margemUltimoMesFechado(null, ['oben'], 11)).toEqual(vazio);
    expect(margemUltimoMesFechado(DRE, ['oben'], 1)).toEqual(vazio);
  });
});

describe('ncgDoEscopo', () => {
  const FONTE = {
    data_referencia: '2026-11-19',
    ncg_por_empresa: [
      { company: 'oben', ncg: 300, presente: true, completa: true },
      { company: 'colacor', ncg: 200, presente: true, completa: true },
      { company: 'colacor_sc', ncg: null, presente: false, completa: false },
    ],
  };

  it('soma os CNPJs presentes do escopo', () => {
    expect(ncgDoEscopo(FONTE, ['oben', 'colacor'])).toEqual({ valor: 500, dataReferencia: '2026-11-19', completa: true });
  });

  it('snapshot sem estoque marca a NCG como parcial (valor mantido, igual ao cockpit)', () => {
    const fonte = {
      ...FONTE,
      ncg_por_empresa: FONTE.ncg_por_empresa.map((n) => (n.company === 'colacor' ? { ...n, completa: false } : n)),
    };
    expect(ncgDoEscopo(fonte, ['oben', 'colacor'])).toEqual({ valor: 500, dataReferencia: '2026-11-19', completa: false });
    expect(ncgDoEscopo(fonte, ['oben']).completa).toBe(true);
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
    expect(linhas[0].margem).toEqual({ valor: 0.25, mes: 10, semCmv: [], servicoFora: [] });
    expect(linhas[1].margem).toEqual({ valor: null, mes: null, semCmv: [], servicoFora: [] });
    expect(linhas[1].caixa.saldo).toBe(50);
  });
});

describe('caixaProjetadoDoEscopo', () => {
  const HOJE = '2026-11-21';
  const segunda = (i: number) => new Date(Date.UTC(2026, 10, 16 + 7 * i)).toISOString().slice(0, 10);
  /** abertura + fechamentos; completa até 13 semanas repetindo o último fechamento. */
  const snap = (company: string, at: string, abertura: number | null, fechamentos: number[], n = 13): SnapshotEmpresa => {
    const fins = Array.from({ length: n }, (_, i) => fechamentos[Math.min(i, fechamentos.length - 1)]);
    return {
      company,
      snapshot_at: `${at}T10:00:00Z`,
      ncg: null,
      ncg_completa: null,
      saldo_tesouraria: abertura,
      semanas: fins.map((fim, i) => ({
        inicio: segunda(i),
        total_entradas: 0,
        total_saidas: 0,
        saldo_inicial: i === 0 ? abertura : fins[i - 1],
        saldo_final: fim,
      })),
    };
  };
  const GRUPO = ['oben', 'colacor', 'colacor_sc'] as const;

  it('falta = Σ déficit no pior saldo de cada CNPJ, sem abater a sobra de outro (prod 21/11)', () => {
    const r = caixaProjetadoDoEscopo(
      [
        snap('colacor', HOJE, -327, [-333, -272, -361]),
        snap('colacor_sc', HOJE, -203, [-211, -234, -220]),
        snap('oben', HOJE, 854, [858, 932, 1149]),
      ],
      [...GRUPO],
      HOJE,
    );
    expect(r.falta).toBe(361 + 234);
    expect(r.diasDefasagem).toBe(0);
    expect(r.porEmpresa).toEqual([
      { empresa: 'oben', motivo: null, negativaHoje: false, primeiraNegativa: null, pior: { inicio: '2026-11-16', saldo: 854 }, snapshot: HOJE },
      { empresa: 'colacor', motivo: null, negativaHoje: true, primeiraNegativa: '2026-11-16', pior: { inicio: '2026-11-30', saldo: -361 }, snapshot: HOJE },
      { empresa: 'colacor_sc', motivo: null, negativaHoje: true, primeiraNegativa: '2026-11-16', pior: { inicio: '2026-11-23', saldo: -234 }, snapshot: HOJE },
    ]);
  });

  it('positiva hoje que vira negativa: semana de virada e pior saldo', () => {
    const r = caixaProjetadoDoEscopo([snap('oben', HOJE, 100, [50, -30, -80, 10])], ['oben'], HOJE);
    expect(r.falta).toBe(80);
    expect(r.porEmpresa[0]).toMatchObject({ negativaHoje: false, primeiraNegativa: '2026-11-23', pior: { inicio: '2026-11-30', saldo: -80 } });
  });

  it('abertura negativa pior que todo fechamento: o pior é o de agora', () => {
    const r = caixaProjetadoDoEscopo([snap('oben', HOJE, -500, [-400, -300])], ['oben'], HOJE);
    expect(r.falta).toBe(500);
    expect(r.porEmpresa[0].pior).toEqual({ inicio: '2026-11-16', saldo: -500 });
  });

  it('ninguém negativo → falta 0 (zero legítimo)', () => {
    expect(caixaProjetadoDoEscopo([snap('oben', HOJE, 10, [20, 30])], ['oben'], HOJE).falta).toBe(0);
  });

  it('ausente ≠ zero: CNPJ sem snapshot anula a falta e diz o motivo', () => {
    const r = caixaProjetadoDoEscopo([snap('colacor', HOJE, -10, [-20])], ['oben', 'colacor'], HOJE);
    expect(r.falta).toBeNull();
    expect(r.porEmpresa.map((e) => e.motivo)).toEqual(['ausente', null]);
    expect(caixaProjetadoDoEscopo(null, ['oben'], HOJE)).toEqual({ falta: null, porEmpresa: [], diasDefasagem: null });
  });

  it('horizonte incompleto (semana faltando ou abertura nula) → null, nunca "nenhuma"', () => {
    const curta = snap('oben', HOJE, 100, [100], 12);
    const buraco = snap('oben', HOJE, 100, [100]);
    buraco.semanas = buraco.semanas.filter((_, i) => i !== 5);
    const semAbertura = snap('oben', HOJE, null, [-10, 50]);
    for (const s of [curta, buraco, semAbertura]) {
      const r = caixaProjetadoDoEscopo([s], ['oben'], HOJE);
      expect(r.falta).toBeNull();
      expect(r.porEmpresa[0].motivo).toBe('incompleta');
    }
  });

  it('mesma coorte do cockpit: CNPJ com snapshot de dia anterior é "desatualizada"', () => {
    const r = caixaProjetadoDoEscopo(
      [snap('oben', '2026-11-20', 10, [20]), snap('colacor', HOJE, 5, [6])],
      ['oben', 'colacor'],
      HOJE,
    );
    expect(r.falta).toBeNull();
    expect(r.porEmpresa.map((e) => e.motivo)).toEqual(['desatualizada', null]);
  });

  it('usa o snapshot mais recente de cada CNPJ e mede a defasagem pela coorte', () => {
    const r = caixaProjetadoDoEscopo(
      [snap('oben', '2026-11-10', -999, [-999]), snap('oben', '2026-11-18', 10, [20]), snap('colacor', '2026-11-18', 5, [6])],
      ['oben', 'colacor'],
      HOJE,
    );
    expect(r.falta).toBe(0);
    expect(r.porEmpresa[0].snapshot).toBe('2026-11-18');
    expect(r.diasDefasagem).toBe(3);
  });

  it('horizonte de 13 semanas: a 14ª semana não entra', () => {
    const r = caixaProjetadoDoEscopo([snap('oben', HOJE, 100, [...Array(13).fill(100), -50], 14)], ['oben'], HOJE);
    expect(r.falta).toBe(0);
    expect(r.porEmpresa[0].primeiraNegativa).toBeNull();
  });
});

describe('cobrança do CEO', () => {
  const linha = (o: Record<string, unknown>) => ({
    company: 'oben', omie_codigo_cliente: 1, nome_cliente: 'Cliente A', saldo_vencido: 100, n_vencidas: 1,
    dias_vencido_max: 10, dona_user_id: 'u1', dona_nome: 'Ana', estado: 'a_contatar', promessa_situacao: null, ...o,
  });
  const dev = (o: Record<string, unknown>) => devedorDaFila(linha(o))!;

  it('devedorDaFila: chave empresa × código; saldo ausente vira null, nunca 0', () => {
    expect(devedorDaFila(linha({}))).toEqual({
      company: 'oben', codigo: 1, nome: 'Cliente A', saldoVencido: 100, nVencidas: 1, diasMax: 10, antigo: false,
      responsavel: 'Ana', estado: 'a_contatar', promessaVencida: false,
    });
    expect(dev({ saldo_vencido: null }).saldoVencido).toBeNull();
    expect(dev({ saldo_vencido: '250.5' }).saldoVencido).toBe(250.5);
    expect(dev({ dona_user_id: null }).responsavel).toBeNull();
    expect(dev({ nome_cliente: '  ' }).nome).toBeNull();
    expect(dev({ promessa_situacao: 'vencida' }).promessaVencida).toBe(true);
    expect(dev({ dias_vencido_max: 366 }).antigo).toBe(true);
    expect(dev({ dias_vencido_max: 365 }).antigo).toBe(false);
    expect(devedorDaFila(linha({ company: 'outra' }))).toBeNull();
    expect(devedorDaFila(linha({ omie_codigo_cliente: null }))).toBeNull();
  });

  it('mesmo cliente em 2 empresas credoras são 2 devedores (cadastros fiscais legítimos)', () => {
    const c = cobrancaDoEscopo(
      { oben: [dev({ saldo_vencido: 300 })], colacor: [], colacor_sc: [dev({ company: 'colacor_sc', saldo_vencido: 200 })] },
      ['oben', 'colacor', 'colacor_sc'],
    );
    expect(c?.devedores).toBe(2);
    expect(c?.top.map((d) => [d.company, d.saldoVencido])).toEqual([['oben', 300], ['colacor_sc', 200]]);
  });

  it('ordem acionável: promessa vencida, depois por saldo até 1 ano, antigos no fim; fora da fila quem aguarda', () => {
    const promessa = dev({ omie_codigo_cliente: 1, saldo_vencido: 10, estado: 'promessa', promessa_situacao: 'vencida' });
    const grande = dev({ omie_codigo_cliente: 2, saldo_vencido: 500, estado: 'contatado' });
    const antigoGrande = dev({ omie_codigo_cliente: 3, saldo_vencido: 9000, dias_vencido_max: 800 });
    const pequeno = dev({ omie_codigo_cliente: 4, saldo_vencido: 50, dona_user_id: null });
    const disputa = dev({ omie_codigo_cliente: 5, saldo_vencido: 7000, estado: 'disputa' });
    const c = cobrancaDoEscopo({ oben: [antigoGrande, pequeno, disputa, grande, promessa] }, ['oben']);
    expect(c?.top).toEqual([promessa, grande, pequeno, antigoGrande]);
    expect(c?.aguardando).toBe(1);
    expect(c?.devedores).toBe(5);
    expect(c?.semResponsavel).toEqual({ n: 1, valor: 50 });
    expect(cobrancaDoEscopo({ oben: [antigoGrande, pequeno, grande, promessa] }, ['oben'], 2)?.top).toEqual([promessa, grande]);
  });

  it('promessa vencida com saldo ilegível não some; caso sem vencido não é "saldo desconhecido"', () => {
    const c = cobrancaDoEscopo(
      { oben: [dev({ saldo_vencido: null, promessa_situacao: 'vencida' }), dev({ omie_codigo_cliente: 2, saldo_vencido: null, n_vencidas: 0 })] },
      ['oben'],
    );
    expect(c).toEqual({
      devedores: 0, semResponsavel: { n: 0, valor: 0 }, promessasVencidas: 1, saldoDesconhecido: 1, aguardando: 0, top: [],
    });
  });

  it('fila de alguma empresa do escopo não lida → null (nunca "ninguém deve")', () => {
    expect(cobrancaDoEscopo({ oben: [] }, ['oben', 'colacor'])).toBeNull();
    expect(cobrancaDoEscopo(null, ['oben'])).toBeNull();
    expect(cobrancaDoEscopo({ oben: [] }, ['oben'])).toEqual({
      devedores: 0, semResponsavel: { n: 0, valor: 0 }, promessasVencidas: 0, saldoDesconhecido: 0, aguardando: 0, top: [],
    });
  });
});

describe('composicaoMargem', () => {
  const linha = (company: string, mes: number, receita: number, cmv: number | null, extra: Partial<DreLinha> = {}): DreLinha => ({
    company, mes, receita_liquida: receita, cmv, lucro_bruto: receita - (cmv ?? 0), ...extra,
  });

  it('receita, CMV, lucro e margem por empresa de mercadoria no mês do tile; SC (serviço) fora', () => {
    const dre = [
      linha('oben', 9, 1000, 600), linha('oben', 10, 1000, 650, { qtd_categorias_sem_mapeamento: 2 }),
      linha('colacor', 10, 500, 300, { qtd_categorias_sem_mapeamento: 0, resultado_provisorio: true }),
      linha('colacor_sc', 10, 800, 0),
    ];
    const c = composicaoMargem(dre, ['oben', 'colacor', 'colacor_sc'], 11);
    expect(c.mes).toBe(10);
    expect(c.linhas).toEqual([
      { empresa: 'oben', receitaLiquida: 1000, cmv: 650, lucroBruto: 350, margem: 0.35, margemAnterior: 0.4, semMapeamento: 2, provisorio: false },
      { empresa: 'colacor', receitaLiquida: 500, cmv: 300, lucroBruto: 200, margem: 0.4, margemAnterior: null, semMapeamento: 0, provisorio: true },
    ]);
  });

  it('tile sem margem (CMV não classificado ou sem mês comum) → composição vazia, nunca parcial', () => {
    expect(composicaoMargem([linha('oben', 10, 1000, 0)], ['oben'], 11)).toEqual({ mes: null, linhas: [] });
    expect(composicaoMargem(null, ['oben'], 11)).toEqual({ mes: null, linhas: [] });
    expect(composicaoMargem([linha('oben', 10, 1000, 600)], ['oben', 'colacor'], 11)).toEqual({ mes: null, linhas: [] });
  });

  it('confiança ausente fica null ("não informada"), nunca "mapeada"', () => {
    expect(composicaoMargem([linha('oben', 10, 1000, 600)], ['oben'], 11).linhas[0].semMapeamento).toBeNull();
  });
});
