import { describe, it, expect } from 'vitest';
import { classificarLinhaDRE, REGIME_POR_EMPRESA, resolverDataCaixa, valorCaixaEfetivo, dedupePorCodigo, bucketizarCaixa, montarDRE, scoreConfianca, calcularRBT12, aliquotaEfetivaSimples, anexoPorFatorR, impostoTeoricoSimples, impostoTeoricoPresumido, normalizarConfigTributario } from '../dre-helpers';

const M = (pairs: Array<[string, string]>) => new Map<string, string>(pairs);

describe('REGIME_POR_EMPRESA', () => {
  it('mapeia as 3 empresas', () => {
    expect(REGIME_POR_EMPRESA.colacor).toBe('presumido');
    expect(REGIME_POR_EMPRESA.oben).toBe('presumido');
    expect(REGIME_POR_EMPRESA.colacor_sc).toBe('simples');
  });
});

describe('classificarLinhaDRE — mapping explícito', () => {
  it('usa dre_linha de imposto do mapping (presumido: ICMS → ded_icms)', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '3.05', categoria_descricao: 'ICMS sobre vendas',
      isReceita: false, regime: 'presumido', mapping: M([['3.05', 'ded_icms']]),
    });
    expect(r.linha).toBe('ded_icms');
    expect(r.mapeado).toBe(true);
    expect(r.viaFallback).toBe(false);
  });

  it('prefix match', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '3.01.02.003', categoria_descricao: 'x',
      isReceita: false, regime: 'presumido', mapping: M([['3.01', 'cmv']]),
    });
    expect(r.linha).toBe('cmv');
    expect(r.mapeado).toBe(true);
  });
});

describe('classificarLinhaDRE — fallback regime-aware de imposto', () => {
  it('presumido: keyword IRPJ não mapeado → irpj + viaFallback', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '9.99', categoria_descricao: 'IRPJ trimestral',
      isReceita: false, regime: 'presumido', mapping: M([]),
    });
    expect(r.linha).toBe('irpj');
    expect(r.mapeado).toBe(false);
    expect(r.viaFallback).toBe(true);
    expect(r.impostoNaoMapeado).toBe(true);
  });

  it('presumido: PIS → ded_pis; COFINS → ded_cofins; ISS → ded_iss; IPI → ded_ipi', () => {
    const reg = 'presumido' as const;
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'PIS', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_pis');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'COFINS', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_cofins');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'ISS retido', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_iss');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'IPI', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_ipi');
  });

  it('SIMPLES: qualquer imposto por keyword → das (linha única, nunca quebra)', () => {
    const reg = 'simples' as const;
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'DAS Simples Nacional', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('das');
    const r = classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'ICMS', isReceita: false, regime: reg, mapping: M([]) });
    expect(r.linha).toBe('das');
    expect(r.impostoNaoMapeado).toBe(true);
  });
});

describe('classificarLinhaDRE — não-imposto', () => {
  it('CMV por keyword', () => {
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'Custo mercadoria vendida', isReceita: false, regime: 'presumido', mapping: M([]) }).linha).toBe('cmv');
  });
  it('receita: devolução → deducoes', () => {
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'Devolução de venda', isReceita: true, regime: 'presumido', mapping: M([]) }).linha).toBe('deducoes');
  });
  it('receita não mapeada → receita_bruta (fallback)', () => {
    const r = classificarLinhaDRE({ categoria_codigo: '1.99', categoria_descricao: 'Venda balcão', isReceita: true, regime: 'presumido', mapping: M([]) });
    expect(r.linha).toBe('receita_bruta');
    expect(r.viaFallback).toBe(true);
  });
});

describe('resolverDataCaixa', () => {
  it('usa data real quando presente', () => {
    expect(resolverDataCaixa({ data_real: '2026-03-10', data_vencimento: '2026-03-05' }))
      .toEqual({ data_efetiva: '2026-03-10', usou_fallback: false });
  });
  it('cai pro vencimento quando data real falta', () => {
    expect(resolverDataCaixa({ data_real: null, data_vencimento: '2026-03-05' }))
      .toEqual({ data_efetiva: '2026-03-05', usou_fallback: true });
  });
  it('sem nenhuma data → null', () => {
    expect(resolverDataCaixa({ data_real: null, data_vencimento: null }))
      .toEqual({ data_efetiva: null, usou_fallback: false });
  });
});

describe('valorCaixaEfetivo (robusto a valor_recebido=0/null)', () => {
  it('usa o valor real quando > 0', () => {
    expect(valorCaixaEfetivo(800, 1000)).toBe(800);
  });
  it('valor_recebido = 0 (liquidado, #396) → valor_documento (NÃO zero)', () => {
    expect(valorCaixaEfetivo(0, 1000)).toBe(1000);
  });
  it('valor_recebido null → valor_documento', () => {
    expect(valorCaixaEfetivo(null, 1000)).toBe(1000);
  });
  it('ambos ausentes → 0', () => {
    expect(valorCaixaEfetivo(0, null)).toBe(0);
  });
});

describe('dedupePorCodigo (anti double-count do load DRE-caixa)', () => {
  it('dedupe por omie_codigo_lancamento, mantém a 1ª ocorrência', () => {
    const r = dedupePorCodigo([
      { omie_codigo_lancamento: 1, v: 'a' },
      { omie_codigo_lancamento: 1, v: 'b' }, // duplicata (venc-no-mês ∩ baixa-no-mês)
      { omie_codigo_lancamento: 2, v: 'c' },
    ]);
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.omie_codigo_lancamento === 1)?.v).toBe('a');
  });
  it('linhas SEM código (null) são todas preservadas', () => {
    const r = dedupePorCodigo([
      { omie_codigo_lancamento: null, v: 'x' },
      { omie_codigo_lancamento: null, v: 'y' },
      { omie_codigo_lancamento: 5, v: 'z' },
    ]);
    expect(r).toHaveLength(3);
  });
});

describe('bucketizarCaixa', () => {
  const titulos = [
    { valor: 100000, data_real: '2026-03-10', data_vencimento: '2026-03-01' },
    { valor: 50000, data_real: null, data_vencimento: '2026-03-20' },
    { valor: 999, data_real: '2026-02-10', data_vencimento: '2026-03-02' },
  ];
  it('soma só o que cai no mês pela data efetiva, e mede fallback_pct por valor', () => {
    const r = bucketizarCaixa(titulos, '2026-03-01', '2026-04-01');
    expect(r.total).toBe(150000);
    expect(r.total_fallback).toBe(50000);
    expect(r.fallback_pct).toBeCloseTo(50000 / 150000, 5);
    expect(r.itens.length).toBe(2);
  });
  it('total 0 → fallback_pct 0', () => {
    expect(bucketizarCaixa([], '2026-03-01', '2026-04-01').fallback_pct).toBe(0);
  });
});

const tot = (o: Partial<Record<string, number>>) => o as Record<string, number>;

describe('montarDRE — presumido', () => {
  it('indiretos nas deduções, IRPJ/CSLL abaixo', () => {
    const r = montarDRE({
      regime: 'presumido',
      totais: tot({
        receita_bruta: 100000, deducoes: 2000,
        ded_icms: 12000, ded_pis: 650, ded_cofins: 3000,
        cmv: 40000, despesas_administrativas: 10000,
        irpj: 5000, csll: 3000,
      }),
    });
    expect(r.deducoes).toBe(17650);
    expect(r.receita_liquida).toBe(100000 - 17650);
    expect(r.lucro_bruto).toBe(100000 - 17650 - 40000);
    expect(r.impostos).toBe(8000);
    expect(r.resultado_liquido).toBe(r.resultado_antes_impostos - 8000);
    expect(r.detalhamento_impostos).toEqual({ ded_icms: 12000, ded_pis: 650, ded_cofins: 3000, irpj: 5000, csll: 3000 });
  });
});

describe('montarDRE — Simples', () => {
  it('DAS entra nas deduções (linha única), imposto sobre lucro = 0', () => {
    const r = montarDRE({
      regime: 'simples',
      totais: tot({ receita_bruta: 100000, deducoes: 1000, das: 6000, cmv: 30000, despesas_administrativas: 8000 }),
    });
    expect(r.deducoes).toBe(7000);
    expect(r.receita_liquida).toBe(93000);
    expect(r.impostos).toBe(0);
    expect(r.resultado_liquido).toBe(r.resultado_antes_impostos);
    expect(r.detalhamento_impostos).toEqual({ das: 6000 });
  });
});

describe('scoreConfianca', () => {
  it('tudo bom → alta', () => {
    const r = scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0.02, share_generico: 0.01, tem_imposto_nao_mapeado: false });
    expect(r.nivel).toBe('alta');
    expect(r.motivos).toEqual([]);
  });
  it('fallback alto rebaixa pra media (>10%) e baixa (>20%)', () => {
    expect(scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0.15, share_generico: 0, tem_imposto_nao_mapeado: false }).nivel).toBe('media');
    expect(scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0.25, share_generico: 0, tem_imposto_nao_mapeado: false }).nivel).toBe('baixa');
  });
  it('pouco mapeado por valor rebaixa', () => {
    const r = scoreConfianca({ pct_mapeado_valor: 0.7, fallback_pct: 0, share_generico: 0, tem_imposto_nao_mapeado: false });
    expect(r.nivel).toBe('baixa');
    expect(r.motivos.some(m => m.includes('mapead'))).toBe(true);
  });
  it('imposto não mapeado vira motivo (rebaixa pra no máximo media)', () => {
    const r = scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0, share_generico: 0, tem_imposto_nao_mapeado: true });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some(m => m.toLowerCase().includes('imposto'))).toBe(true);
  });
});

describe('calcularRBT12', () => {
  const hist = [
    { ano: 2025, mes: 6, receita_bruta: 50000 },
    { ano: 2026, mes: 4, receita_bruta: 30000 },
    { ano: 2026, mes: 5, receita_bruta: 40000 },
    { ano: 2024, mes: 1, receita_bruta: 99999 },
  ];
  it('soma os 12 meses ANTERIORES ao mês de apuração', () => {
    expect(calcularRBT12(hist, 2026, 5)).toBe(80000);
  });
  it('sem histórico → 0', () => {
    expect(calcularRBT12([], 2026, 5)).toBe(0);
  });
});

describe('faixaPorRBT12 / aliquotaEfetivaSimples (Anexo III)', () => {
  it('RBT12 na 2ª faixa: efetiva = (RBT12*nominal - deduzir)/RBT12', () => {
    // Anexo III, RBT12 = 300.000 → faixa 2 (0.112, deduzir 9360); efetiva = (33600-9360)/300000 = 0.0808
    expect(aliquotaEfetivaSimples('III', 300000)).toBeCloseTo(0.0808, 4);
  });
  it('RBT12 = 0 → 0', () => {
    expect(aliquotaEfetivaSimples('III', 0)).toBe(0);
  });
  it('última faixa por excesso (acima de 4.8M usa a última)', () => {
    expect(aliquotaEfetivaSimples('III', 5000000)).toBeGreaterThan(0);
  });
});

describe('anexoPorFatorR', () => {
  it('fator-r ≥ 28% → III; < 28% → V', () => {
    expect(anexoPorFatorR(0.30)).toBe('III');
    expect(anexoPorFatorR(0.20)).toBe('V');
  });
});

describe('impostoTeoricoSimples', () => {
  it('DAS teórico = efetiva × receita do mês', () => {
    const r = impostoTeoricoSimples({ anexo: 'III', rbt12: 300000, receitaMes: 25000 });
    expect(r).toBeCloseTo(0.0808 * 25000, 0);
  });
  it('sem anexo → null (degrade)', () => {
    expect(impostoTeoricoSimples({ anexo: null, rbt12: 300000, receitaMes: 25000 })).toBeNull();
  });
});

describe('impostoTeoricoPresumido', () => {
  it('IRPJ+CSLL trimestral + PIS/COFINS; adicional só sobre excedente de 60k', () => {
    const r = impostoTeoricoPresumido({ receitaTrimestre: 1000000, presuncaoIrpj: 0.08, presuncaoCsll: 0.12 });
    expect(r.irpj).toBeCloseTo(14000, 0);   // 12000 + 10% sobre (80000-60000)=2000
    expect(r.csll).toBeCloseTo(10800, 0);
    expect(r.pis).toBeCloseTo(6500, 0);
    expect(r.cofins).toBeCloseTo(30000, 0);
  });
  it('sem excedente → sem adicional', () => {
    const r = impostoTeoricoPresumido({ receitaTrimestre: 100000, presuncaoIrpj: 0.08, presuncaoCsll: 0.12 });
    expect(r.irpj).toBeCloseTo(1200, 0);    // base 8000 < 60000 → adicional 0
  });
});

describe('normalizarConfigTributario', () => {
  it('config ausente → default por empresa (Colacor SC = simples, sem anexo → degrada)', () => {
    const c = normalizarConfigTributario('colacor_sc', null);
    expect(c.regime).toBe('simples');
    expect(c.anexo).toBeNull();
    expect(c.completa).toBe(false);
  });
  it('config presente: presumido com presunções → completa', () => {
    const c = normalizarConfigTributario('colacor', { regime: 'presumido', presuncao_irpj: 0.08, presuncao_csll: 0.12 });
    expect(c.regime).toBe('presumido');
    expect(c.presuncaoIrpj).toBe(0.08);
    expect(c.completa).toBe(true);
  });
  it('simples COM anexo → completa', () => {
    const c = normalizarConfigTributario('colacor_sc', { regime: 'simples', anexo: 'III' });
    expect(c.anexo).toBe('III');
    expect(c.completa).toBe(true);
  });
});
