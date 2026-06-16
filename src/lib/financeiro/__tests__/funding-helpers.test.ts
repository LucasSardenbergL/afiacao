import { describe, it, expect } from 'vitest';
import { iofCredito, custoEmReais, custoAntecipacao, custoOportunidadeCaixa } from '../funding-helpers';
import { classificarContexto, checaValeEmT, classificarEstrutural, type Semana } from '../funding-helpers';
import { decidirTitulo } from '../funding-helpers';
import { identificarGap, montarPlanoCobertura, type FonteCobertura } from '../funding-helpers';

describe('iofCredito', () => {
  it('aplica 0,38% fixo + 0,0082%/dia', () => {
    // 30 dias: 0,0038 + 0,000082*30 = 0,0038 + 0,00246 = 0,00626
    expect(iofCredito(1000, 30)).toBeCloseTo(1000 * 0.00626, 4);
  });
  it('limita a parcela diária a 365 dias', () => {
    expect(iofCredito(1000, 999)).toBeCloseTo(iofCredito(1000, 365), 6);
  });
  it('zero pra dias<=0', () => { expect(iofCredito(1000, 0)).toBe(1000 * 0.0038); });
});

describe('custoEmReais', () => {
  it('M*((1+r)^(D/365)-1)', () => {
    expect(custoEmReais(10000, 365, 0.20)).toBeCloseTo(2000, 2); // 1 ano a 20%
    expect(custoEmReais(10000, 30, 0.20)).toBeCloseTo(10000 * (Math.pow(1.2, 30/365) - 1), 4);
  });
  it('zero em inputs não-positivos', () => {
    expect(custoEmReais(0, 30, 0.2)).toBe(0);
    expect(custoEmReais(1000, 0, 0.2)).toBe(0);
    expect(custoEmReais(1000, 30, 0)).toBe(0);
  });
});

describe('custoAntecipacao', () => {
  it('desconto: deságio por fora + IOF + tarifa; custo_rs = V - v_liq', () => {
    const r = custoAntecipacao({ valor: 10000, dias: 30, taxa_desconto_mensal: 0.022, tipo: 'desconto', tarifa_fixa: 5 });
    const desagio = 10000 * 0.022 * (30/30); // 220
    const iof = 10000 * 0.00626;             // 62,6
    expect(r.desagio).toBeCloseTo(desagio, 4);
    expect(r.iof).toBeCloseTo(iof, 4);
    expect(r.v_liq).toBeCloseTo(10000 - desagio - iof - 5, 4);
    expect(r.custo_rs).toBeCloseTo(10000 - r.v_liq, 6);
    expect(r.taxa_efetiva_aa).toBeCloseTo(Math.pow(10000 / r.v_liq, 365/30) - 1, 6);
  });
  it('factoring: IOF zero', () => {
    const r = custoAntecipacao({ valor: 10000, dias: 30, taxa_desconto_mensal: 0.03, tipo: 'factoring' });
    expect(r.iof).toBe(0);
  });
  it('v_liq<=0 → taxa_efetiva null', () => {
    const r = custoAntecipacao({ valor: 100, dias: 30, taxa_desconto_mensal: 2, tipo: 'desconto' });
    expect(r.taxa_efetiva_aa).toBeNull();
  });
});

describe('custoOportunidadeCaixa', () => {
  it('ocioso → cm_anual', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: 0.4, ha_fila_a4_positiva: false, caixa_suficiente: true })).toBe(0.18);
  });
  it('fila A4 positiva + caixa insuficiente → max(cm, retorno A4)', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: 0.40, ha_fila_a4_positiva: true, caixa_suficiente: false })).toBe(0.40);
  });
  it('sem retorno A4 informado → cm_anual', () => {
    expect(custoOportunidadeCaixa({ cm_anual: 0.18, retorno_marginal_a4: null, ha_fila_a4_positiva: true, caixa_suficiente: false })).toBe(0.18);
  });
});

const semanas = (saldos: number[], entradas: Record<number, {id:string;valor:number}[]> = {}): Semana[] =>
  saldos.map((s, i) => ({
    inicio: `2026-W${i}`, fim: `2026-W${i}`, saldo_final: s, total_saidas: 0,
    entradas: (entradas[i] ?? []).map(e => ({ id_origem: e.id, data: `2026-W${i}`, valor: e.valor })),
  }));

describe('classificarContexto', () => {
  it('sem projeção → indefinido', () => {
    expect(classificarContexto({ tem_projecao: false, menor_saldo_ate_n: null, reserva_rs: 1000 })).toBe('indefinido');
  });
  it('menor saldo < reserva → gap', () => {
    expect(classificarContexto({ tem_projecao: true, menor_saldo_ate_n: 500, reserva_rs: 1000 })).toBe('gap');
  });
  it('menor saldo >= reserva → sobra', () => {
    expect(classificarContexto({ tem_projecao: true, menor_saldo_ate_n: 5000, reserva_rs: 1000 })).toBe('sobra');
  });
});

describe('checaValeEmT', () => {
  it('antecipar cria vale em T quando o recebimento era necessário', () => {
    const s = semanas([11000, 10500, 10000], { 2: [{ id: 'T1', valor: 10000 }] });
    expect(checaValeEmT({ semanas: s, titulo_id: 'T1', v_liq: 1000, reserva_rs: 2000 })).toBe(true);
  });
  it('não cria vale quando há folga', () => {
    const s = semanas([11000, 10500, 30000], { 2: [{ id: 'T1', valor: 10000 }] });
    expect(checaValeEmT({ semanas: s, titulo_id: 'T1', v_liq: 9000, reserva_rs: 2000 })).toBe(false);
  });
  it('título fora do horizonte (não está na projeção) → false', () => {
    const s = semanas([11000, 10500, 10000]);
    expect(checaValeEmT({ semanas: s, titulo_id: 'X', v_liq: 1000, reserva_rs: 2000 })).toBe(false);
  });
});

describe('classificarEstrutural', () => {
  it('gap em >= limiar semanas → estrutural', () => {
    const s = semanas([500, 500, 500, 500, 500, 500, 9000]); // 6 semanas < reserva 1000
    expect(classificarEstrutural({ semanas: s, reserva_rs: 1000, limiar_semanas: 6 })).toBe(true);
  });
  it('gap pontual → não estrutural', () => {
    const s = semanas([9000, 9000, 500, 9000]);
    expect(classificarEstrutural({ semanas: s, reserva_rs: 1000, limiar_semanas: 6 })).toBe(false);
  });
});

const baseTitulo = { id: 'T1', valor: 10000, dias: 30, nome_cliente: 'ACME' };
const baseAnt = { taxa_desconto_mensal: 0.022, tipo: 'desconto' as const, coobrigacao: true };

describe('decidirTitulo', () => {
  it('GAP: antecipação mais barata que a alternativa → antecipar (net>0)', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt,
      alternativas: { capital_giro_cet: null, cheque_cet: 2.0 },
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('antecipar');
    expect(d.net_rs!).toBeGreaterThan(0);
    expect(d.benchmark_fonte).toBe('cheque_especial');
    expect(d.flags).toContain('coobrigacao');
  });
  it('GAP: antecipação mais cara que dívida barata → não antecipar', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt,
      alternativas: { capital_giro_cet: 0.10, cheque_cet: null },
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('nao_antecipar');
    expect(d.net_rs!).toBeLessThan(0);
  });
  it('GAP: com AS DUAS alternativas, faz benchmark contra a MAIS BARATA (capital de giro < cheque)', () => {
    // gap real com linha de capital de giro (10% a.a.) E cheque especial (200% a.a.) disponíveis:
    // o benchmark da antecipação tem de ser a fonte MAIS BARATA, não a mais cara (senão o net infla e
    // enviesa pra "antecipar"). Fecha o gap de cobertura: os outros casos GAP passam 1 alternativa só.
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt,
      alternativas: { capital_giro_cet: 0.10, cheque_cet: 2.0 },
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.benchmark_fonte).toBe('capital_giro'); // a mais barata, não 'cheque_especial'
    const soCheque = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt,
      alternativas: { capital_giro_cet: null, cheque_cet: 2.0 },
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.custo_rs_benchmark!).toBeLessThan(soCheque.custo_rs_benchmark!); // pegou o barato (giro), não o caro (cheque)
  });
  it('SOBRA: deságio > cm_anual e sem uso A4 → não antecipar', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'sobra', flags_extra: [],
    });
    expect(d.recomendacao).toBe('nao_antecipar');
    expect(d.benchmark_fonte).toBe('caixa_proprio');
  });
  it('SOBRA com uso A4 de altíssimo retorno → antecipar', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: 5.0, contexto: 'sobra', flags_extra: [],
    });
    expect(d.recomendacao).toBe('antecipar');
    expect(d.benchmark_fonte).toBe('melhor_uso_a4');
  });
  it('GAP sem nenhuma alternativa informada → falta_dado', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('falta_dado');
  });
  it('v_liq<=0 → falta_dado', () => {
    const d = decidirTitulo({
      titulo: { id: 'T', valor: 100, dias: 30, nome_cliente: null },
      antecipacao: { taxa_desconto_mensal: 2, tipo: 'desconto', coobrigacao: false },
      alternativas: { cheque_cet: 2.0 }, cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('falta_dado');
  });
  it('indefinido (sem projeção) propaga flag sem_projecao', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'indefinido', flags_extra: [],
    });
    expect(d.flags).toContain('sem_projecao');
    expect(d.benchmark_fonte).toBe('caixa_proprio');
  });
  it('taxa de antecipação null (fonte não configurada) → falta_dado, NUNCA antecipar grátis', () => {
    const d = decidirTitulo({
      titulo: baseTitulo,
      antecipacao: { taxa_desconto_mensal: null, tipo: 'desconto', coobrigacao: true },
      alternativas: { cheque_cet: 2.0 }, cm_anual: 0.18, retorno_marginal_a4: null, contexto: 'gap', flags_extra: [],
    });
    expect(d.recomendacao).toBe('falta_dado');
    expect(d.flags).toContain('sem_taxa_antecipacao');
    expect(d.net_rs).toBeNull();
    expect(d.custo_rs_antecipacao).toBe(0);
    expect(d.v_liq).toBe(0);
  });
  it('SOBRA sem cm_anual nem A4 → falta_dado (não fabrica nao_antecipar com benchmark zero)', () => {
    const d = decidirTitulo({
      titulo: baseTitulo, antecipacao: baseAnt, alternativas: {},
      cm_anual: null, retorno_marginal_a4: null, contexto: 'sobra', flags_extra: [],
    });
    expect(d.recomendacao).toBe('falta_dado');
    expect(d.flags).toContain('sem_custo_capital');
    expect(d.net_rs).toBeNull();
  });
});

describe('identificarGap', () => {
  const wk = (saldos: number[]): import('../funding-helpers').Semana[] =>
    saldos.map((s, i) => ({ inicio: `2026-W${i}`, fim: `2026-W${i}`, saldo_final: s, total_saidas: 0, entradas: [] }));
  it('sem semana abaixo da reserva → sem gap', () => {
    expect(identificarGap({ semanas: wk([5000, 6000, 7000]), reserva_rs: 1000 })).toBeNull();
  });
  it('acha o vale mais profundo + gap_rs + horizonte', () => {
    const g = identificarGap({ semanas: wk([3000, 2500, 500, 4000]), reserva_rs: 2000 });
    expect(g).not.toBeNull();
    expect(g!.gap_rs).toBe(1500);
    expect(g!.semana_idx).toBe(2);
    expect(g!.horizonte_dias).toBe(21);
  });
  it('déficit plano/estrutural → horizonte vai até a RECUPERAÇÃO, não a semana do vale', () => {
    // todas abaixo da reserva (vale "empata" no idx 0); horizonte = última abaixo (idx 2) → 21 dias, não 7.
    const g = identificarGap({ semanas: wk([500, 500, 500]), reserva_rs: 1000 });
    expect(g!.gap_rs).toBe(500);
    expect(g!.semana_idx).toBe(0);
    expect(g!.horizonte_dias).toBe(21);
  });
  it('vale no meio mas recupera depois → horizonte até a última semana abaixo', () => {
    // abaixo de 2000 em idx 1 (1500) e idx 2 (800, o vale); idx 3 recupera (3000). horizonte = (2+1)*7=21.
    const g = identificarGap({ semanas: wk([3000, 1500, 800, 3000]), reserva_rs: 2000 });
    expect(g!.semana_idx).toBe(2);
    expect(g!.horizonte_dias).toBe(21);
  });
});

describe('montarPlanoCobertura', () => {
  const fontes = (): FonteCobertura[] => [
    { fonte: 'caixa_proprio', rate_aa: 0.18, capacidade_rs: 1000, governanca_ordem: 0 },
    { fonte: 'capital_giro', rate_aa: 0.30, capacidade_rs: Infinity, governanca_ordem: 1 },
    { fonte: 'cheque_especial', rate_aa: 1.50, capacidade_rs: Infinity, governanca_ordem: 3 },
  ];
  it('preenche o gap do mais barato (R$) pro mais caro, respeitando capacidade', () => {
    const p = montarPlanoCobertura({ gap_rs: 3000, horizonte_dias: 30, fontes: fontes(), cheque_rate_aa: 1.50 });
    expect(p.stack[0].fonte).toBe('caixa_proprio');
    expect(p.stack[0].montante_rs).toBe(1000);
    expect(p.stack.reduce((s, x) => s + x.montante_rs, 0)).toBeCloseTo(3000, 2);
    expect(p.custo_total_rs).toBeGreaterThan(0);
    expect(p.custo_inercia_rs).toBeCloseTo(3000 * (Math.pow(1 + 1.50, 30/365) - 1), 2);
  });
  it('cheque pode vencer gap CURTÍSSIMO em R$ (flag emergência)', () => {
    const p = montarPlanoCobertura({ gap_rs: 5000, horizonte_dias: 2, fontes: [
      { fonte: 'capital_giro', rate_aa: 0.30, capacidade_rs: 0, governanca_ordem: 1 },
      { fonte: 'cheque_especial', rate_aa: 1.50, capacidade_rs: Infinity, governanca_ordem: 3 },
    ], cheque_rate_aa: 1.50 });
    const cheque = p.stack.find((s) => s.fonte === 'cheque_especial');
    expect(cheque).toBeTruthy();
    expect(cheque!.flag).toBe('emergencia');
  });
  it('capacidade insuficiente de todas as fontes → cobre o que dá + flag descoberto', () => {
    const p = montarPlanoCobertura({ gap_rs: 5000, horizonte_dias: 30, fontes: [
      { fonte: 'caixa_proprio', rate_aa: 0.18, capacidade_rs: 1000, governanca_ordem: 0 },
    ], cheque_rate_aa: null });
    expect(p.stack.reduce((s, x) => s + x.montante_rs, 0)).toBe(1000);
    expect(p.motivos.join(' ')).toMatch(/descoberto/i);
    expect(p.custo_inercia_rs).toBeNull(); // sem taxa de cheque → inércia desconhecida (não 0)
  });
});
