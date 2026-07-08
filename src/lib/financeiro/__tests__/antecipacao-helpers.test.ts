import { describe, it, expect } from 'vitest';
import {
  diasEntre,
  custoOperacao,
  medirCusto,
  taxaParaPeriodo,
  compararFunding,
  motivoFluxoRegistro,
} from '../antecipacao-helpers';
import type { Antecipacao, HurdleUnidade } from '../antecipacao-types';

const op = (over: Partial<Parameters<typeof custoOperacao>[0]> = {}) => ({
  valor_bruto: 100_000,
  custos_avulsos: 0,
  valor_liquido: 97_000,
  data_operacao: '2026-01-01',
  data_vencimento: '2026-01-31',
  ...over,
});

describe('diasEntre', () => {
  it('conta dias corridos entre datas ISO (sem drift de TZ)', () => {
    expect(diasEntre('2026-01-01', '2026-01-31')).toBe(30);
    expect(diasEntre('2026-03-01', '2026-03-01')).toBe(0);
  });
});

describe('custoOperacao — caminho feliz', () => {
  it('custo = bruto+avulsos−liquido; taxa período e a.a. de caso conhecido', () => {
    const r = custoOperacao(op());
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(3_000, 2);
    expect(r.dias).toBe(30);
    expect(r.taxa_periodo).toBeCloseTo(100_000 / 97_000 - 1, 6); // ~0,030928
    expect(r.taxa_efetiva_aa).toBeCloseTo(Math.pow(100_000 / 97_000, 365 / 30) - 1, 6); // ~0,4486
  });

  it('custos_avulsos (IOF/tarifa FORA do líquido) entram no custo (P1-4)', () => {
    const r = custoOperacao(op({ custos_avulsos: 500 }));
    expect(r.custo).toBeCloseTo(3_500, 2); // 100000+500−97000
    expect(r.taxa_periodo).toBeCloseTo(100_500 / 97_000 - 1, 6);
  });

  it('líquido == bruto+avulsos → custo 0 / taxa 0, VÁLIDO (P1-1: igualdade não é inválida)', () => {
    const r = custoOperacao(op({ valor_liquido: 100_000, custos_avulsos: 0 }));
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(0, 6);
    expect(r.taxa_periodo).toBeCloseTo(0, 6);
    expect(r.taxa_efetiva_aa).toBeCloseTo(0, 6);
  });
});

describe('custoOperacao — dados_invalidos (helper blinda além do CHECK)', () => {
  it('líquido > bruto+avulsos → dados_invalidos (P1-1: inválido só quando MAIOR)', () => {
    const r = custoOperacao(op({ valor_liquido: 100_001 }));
    expect(r.motivo).toBe('dados_invalidos');
    expect(r.custo).toBeNull();
  });
  it('dias ≤ 0 (venc ≤ operação) → dados_invalidos', () => {
    const r = custoOperacao(op({ data_vencimento: '2026-01-01' }));
    expect(r.motivo).toBe('dados_invalidos');
  });
  it('valores ≤ 0 ou custos_avulsos < 0 → dados_invalidos', () => {
    expect(custoOperacao(op({ valor_bruto: 0 })).motivo).toBe('dados_invalidos');
    expect(custoOperacao(op({ valor_liquido: 0 })).motivo).toBe('dados_invalidos');
    expect(custoOperacao(op({ custos_avulsos: -1 })).motivo).toBe('dados_invalidos');
  });
});

// ── Job A (medirCusto): operação completa (id não é usado pelo helper — fixo por determinismo) ──
const full = (over: Partial<Antecipacao>): Antecipacao => ({
  id: 'op',
  company: 'oben',
  banco: 'Itaú',
  tipo: 'duplicata',
  valor_bruto: 100_000,
  custos_avulsos: 0,
  valor_liquido: 97_000,
  data_operacao: '2026-01-05',
  data_vencimento: '2026-02-04',
  operacao_origem_id: null,
  referencia: null,
  observacao: null,
  deleted_at: null,
  ...over,
});

describe('medirCusto — Job A money-weighted (P1-2)', () => {
  it('taxa realizada reconcilia com R$: custo_total / (Σ líquido×dias / 365)', () => {
    const ops = [
      full({ valor_liquido: 97_000, data_operacao: '2026-01-01', data_vencimento: '2026-01-31' }), // custo 3000, 30d
      full({
        valor_bruto: 52_000,
        valor_liquido: 50_000,
        data_operacao: '2026-02-01',
        data_vencimento: '2026-04-02',
      }), // custo 2000, 60d
    ];
    const r = medirCusto(ops);
    expect(r.motivo).toBe('ok');
    expect(r.custo_total).toBeCloseTo(5_000, 2);
    expect(r.volume_antecipado).toBeCloseTo(147_000, 2);
    const capitalTempo = (97_000 * 30 + 50_000 * 60) / 365; // 16191,78 R$·ano
    expect(r.taxa_realizada_aa).toBeCloseTo(5_000 / capitalTempo, 6); // ~0,3088
    expect(r.num_operacoes).toBe(2);
  });

  it('uma op curtíssima com EAR absurda NÃO infla a taxa (money-weighted, não média de EAR)', () => {
    const ops = [
      full({ valor_bruto: 1_000, valor_liquido: 990, data_operacao: '2026-01-01', data_vencimento: '2026-01-02' }), // 1d
      full({ valor_bruto: 100_000, valor_liquido: 97_000, data_operacao: '2026-01-01', data_vencimento: '2026-01-31' }), // 30d
    ];
    const r = medirCusto(ops);
    const capitalTempo = (990 * 1 + 97_000 * 30) / 365;
    expect(r.taxa_realizada_aa).toBeCloseTo((10 + 3_000) / capitalTempo, 6); // dominada pela op grande
    expect(r.taxa_realizada_aa!).toBeLessThan(1); // < 100% a.a. — não explodiu
  });

  it('tendência mensal por data_operacao (base declarada)', () => {
    const ops = [
      full({ valor_liquido: 97_000, data_operacao: '2026-01-10', data_vencimento: '2026-02-09' }), // jan custo 3000
      full({
        valor_bruto: 52_000,
        valor_liquido: 50_000,
        data_operacao: '2026-02-10',
        data_vencimento: '2026-03-12',
      }), // fev custo 2000
    ];
    const r = medirCusto(ops);
    expect(r.tendencia).toEqual([
      { ano: 2026, mes: 1, custo: 3_000, volume: 97_000 },
      { ano: 2026, mes: 2, custo: 2_000, volume: 50_000 },
    ]);
  });
});

describe('medirCusto — degradação honesta', () => {
  it('sem operações → sem_operacoes (≠ economia/custo zero; P1-6)', () => {
    const r = medirCusto([]);
    expect(r.motivo).toBe('sem_operacoes');
    expect(r.custo_total).toBeNull();
    expect(r.num_operacoes).toBe(0);
  });

  it('soft-deleted é ignorado (não conta no custo)', () => {
    const r = medirCusto([full({ deleted_at: '2026-03-01T00:00:00Z' })]);
    expect(r.motivo).toBe('sem_operacoes');
  });

  it('linha inválida excluída → dados_parciais, agregado só das válidas (nunca "ok" com op ignorada)', () => {
    const ops = [
      full({ valor_liquido: 97_000, data_operacao: '2026-01-01', data_vencimento: '2026-01-31' }), // válida, custo 3000
      full({ valor_bruto: 100_000, valor_liquido: 100_001 }), // inválida (líquido > bruto)
    ];
    const r = medirCusto(ops);
    expect(r.motivo).toBe('dados_parciais');
    expect(r.num_operacoes).toBe(1);
    expect(r.num_excluidas).toBe(1);
    expect(r.custo_total).toBeCloseTo(3_000, 2);
  });

  it('todas inválidas → dados_parciais com agregados null (temos ops, nenhuma custeável)', () => {
    const r = medirCusto([full({ valor_bruto: 100_000, valor_liquido: 100_050 })]);
    expect(r.motivo).toBe('dados_parciais');
    expect(r.num_operacoes).toBe(0);
    expect(r.num_excluidas).toBe(1);
    expect(r.custo_total).toBeNull();
  });
});

describe('taxaParaPeriodo — converte unidade → taxa do período de `dias` (P1-3)', () => {
  it('efetiva_aa composta', () => {
    expect(taxaParaPeriodo(0.3, 'efetiva_aa', 30)).toBeCloseTo(Math.pow(1.3, 30 / 365) - 1, 8);
  });
  it('efetiva_am composta: 2% a.m. em 30 dias ≈ 2%', () => {
    expect(taxaParaPeriodo(0.02, 'efetiva_am', 30)).toBeCloseTo(0.02, 8);
  });
  it('nominal_aa linear: 36,5% a.a. em 30 dias = 3%', () => {
    expect(taxaParaPeriodo(0.365, 'nominal_aa', 30)).toBeCloseTo(0.03, 8);
  });
});

describe('compararFunding — Job B (comparação de FUNDING, nunca "vale a pena")', () => {
  const base = { valor_titulo: 100_000, dias: 30 };

  it('oferta como líquido: custo + taxas; hurdle efetiva_aa convertido p/ 30d → veredito só de funding', () => {
    const r = compararFunding({
      ...base,
      liquido_ofertado: 97_000,
      hurdle: { valor: 0.3, unidade: 'efetiva_aa' },
    });
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(3_000, 2);
    expect(r.taxa_periodo).toBeCloseTo(100_000 / 97_000 - 1, 6); // ~3,09%
    expect(r.hurdle_taxa_periodo).toBeCloseTo(Math.pow(1.3, 30 / 365) - 1, 6); // ~2,18%
    expect(r.veredito).toBe('mais_caro'); // 3,09% > 2,18%
  });

  it('oferta dentro do hurdle → "dentro" (não "vale a pena")', () => {
    const r = compararFunding({
      ...base,
      liquido_ofertado: 99_000,
      hurdle: { valor: 0.6, unidade: 'efetiva_aa' },
    });
    expect(r.veredito).toBe('dentro');
  });

  it('oferta como taxa (com unidade) reconstrói o líquido e custa igual', () => {
    const r = compararFunding({
      ...base,
      taxa_ofertada: { valor: 0.02, unidade: 'efetiva_am' },
      hurdle: { valor: 0.3, unidade: 'efetiva_aa' },
    });
    expect(r.motivo).toBe('ok');
    expect(r.taxa_periodo).toBeCloseTo(0.02, 6); // 2% a.m. em 30d
    expect(r.custo).toBeCloseTo(100_000 - 100_000 / 1.02, 2);
  });

  it('custos_avulsos entram no custo da oferta (P1-4)', () => {
    const r = compararFunding({
      ...base,
      liquido_ofertado: 97_000,
      custos_avulsos: 500,
      hurdle: { valor: 0.3, unidade: 'efetiva_aa' },
    });
    expect(r.custo).toBeCloseTo(3_500, 2); // 100000+500−97000
  });

  it('hurdle ausente → hurdle_indisponivel: mostra custo, sem veredito', () => {
    const r = compararFunding({ ...base, liquido_ofertado: 97_000 });
    expect(r.motivo).toBe('hurdle_indisponivel');
    expect(r.custo).toBeCloseTo(3_000, 2);
    expect(r.veredito).toBeNull();
  });

  it('hurdle sem unidade válida → hurdle_unidade_invalida', () => {
    const r = compararFunding({
      ...base,
      liquido_ofertado: 97_000,
      hurdle: { valor: 0.3, unidade: 'xpto' as HurdleUnidade },
    });
    expect(r.motivo).toBe('hurdle_unidade_invalida');
    expect(r.veredito).toBeNull();
  });

  it('taxa E líquido informados que não reconciliam → inputs_conflitantes', () => {
    const r = compararFunding({
      ...base,
      liquido_ofertado: 90_000,
      taxa_ofertada: { valor: 0.02, unidade: 'efetiva_am' },
      hurdle: { valor: 0.3, unidade: 'efetiva_aa' },
    });
    expect(r.motivo).toBe('inputs_conflitantes');
  });

  it('lote multi-venc num prazo só → fluxo_nao_suportado (inventa prazo, P1-5)', () => {
    const r = compararFunding({
      ...base,
      liquido_ofertado: 97_000,
      lote: true,
      hurdle: { valor: 0.3, unidade: 'efetiva_aa' },
    });
    expect(r.motivo).toBe('fluxo_nao_suportado');
  });

  it('dados inválidos (dias ≤ 0, líquido > face+avulsos) → dados_invalidos', () => {
    expect(compararFunding({ valor_titulo: 100_000, dias: 0, liquido_ofertado: 97_000 }).motivo).toBe(
      'dados_invalidos',
    );
    expect(
      compararFunding({ valor_titulo: 100_000, dias: 30, liquido_ofertado: 100_001 }).motivo,
    ).toBe('dados_invalidos');
  });
});

describe('motivoFluxoRegistro — guard de entrada (form)', () => {
  it('lote=true → fluxo_nao_suportado; senão ok', () => {
    expect(motivoFluxoRegistro({ lote: true })).toBe('fluxo_nao_suportado');
    expect(motivoFluxoRegistro({})).toBe('ok');
  });
});
