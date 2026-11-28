import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classificarLinhaDRE, regimeVigente, regimeAtual, impostoTeoricoTotal, resolverDataCaixa, valorCaixaEfetivo, dedupePorCodigo, bucketizarCaixa, montarDRE, scoreConfianca, calcularRBT12, aliquotaEfetivaSimples, anexoPorFatorR, impostoTeoricoSimples, impostoTeoricoPresumido, normalizarConfigTributario, novoForaDRE, acumularForaDRE, aplicarPendenciasConfianca, linhasDreMapeaveis, provisorioConsolidado, foraDreConsolidado, novoNaoResultado, acumularNaoResultado } from '../dre-helpers';

const M = (pairs: Array<[string, string]>) => new Map<string, string>(pairs);

describe('regimeVigente — regime por (empresa, competência)', () => {
  it('colacor: Simples até dez/2022, Presumido desde jan/2023 (fronteira exata)', () => {
    expect(regimeVigente('colacor', 2020, 2)).toBe('simples');
    expect(regimeVigente('colacor', 2022, 12)).toBe('simples');
    expect(regimeVigente('colacor', 2023, 1)).toBe('presumido');
    expect(regimeVigente('colacor', 2026, 11)).toBe('presumido');
  });
  it('oben sempre presumido; colacor_sc sempre simples', () => {
    for (const [ano, mes] of [[2020, 1], [2022, 12], [2023, 1], [2026, 11]] as const) {
      expect(regimeVigente('oben', ano, mes)).toBe('presumido');
      expect(regimeVigente('colacor_sc', ano, mes)).toBe('simples');
    }
  });
  it('empresa desconhecida → presumido (default histórico do motor)', () => {
    expect(regimeVigente('xpto', 2022, 12)).toBe('presumido');
  });
  it('regimeAtual = regime de hoje (mapa de categorias e badges sem competência)', () => {
    expect(regimeAtual('colacor')).toBe('presumido');
    expect(regimeAtual('oben')).toBe('presumido');
    expect(regimeAtual('colacor_sc')).toBe('simples');
    expect(regimeAtual('xpto')).toBeUndefined();
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
    const c = normalizarConfigTributario('colacor_sc', null, 2026, 11);
    expect(c.regime).toBe('simples');
    expect(c.anexo).toBeNull();
    expect(c.completa).toBe(false);
  });
  it('config presente: presumido com presunções → completa', () => {
    const c = normalizarConfigTributario('colacor', { regime: 'presumido', presuncao_irpj: 0.08, presuncao_csll: 0.12 }, 2026, 11);
    expect(c.regime).toBe('presumido');
    expect(c.presuncaoIrpj).toBe(0.08);
    expect(c.completa).toBe(true);
  });
  it('simples COM anexo → completa', () => {
    const c = normalizarConfigTributario('colacor_sc', { regime: 'simples', anexo: 'III' }, 2026, 11);
    expect(c.anexo).toBe('III');
    expect(c.completa).toBe(true);
  });
  it('colacor na fronteira: config de hoje (presumido) NÃO vale para dez/2022 (simples) → incompleta', () => {
    const cfg = { regime: 'presumido', presuncao_irpj: 0.08, presuncao_csll: 0.12 };
    const dez22 = normalizarConfigTributario('colacor', cfg, 2022, 12);
    expect(dez22.regime).toBe('simples');
    expect(dez22.anexo).toBeNull();
    expect(dez22.completa).toBe(false);
    const jan23 = normalizarConfigTributario('colacor', cfg, 2023, 1);
    expect(jan23.regime).toBe('presumido');
    expect(jan23.completa).toBe(true);
  });
  it('colacor com a config real de prod ({} sem regime): presumido completa, simples sem anexo degrada', () => {
    expect(normalizarConfigTributario('colacor', {}, 2023, 1).completa).toBe(true);
    expect(normalizarConfigTributario('colacor', {}, 2022, 12).completa).toBe(false);
  });
  it('o regime da config não sobrepõe o da competência (config errada não troca a escada)', () => {
    expect(normalizarConfigTributario('oben', { regime: 'simples', anexo: 'I' }, 2026, 11).regime).toBe('presumido');
  });
});

// ── Fase 2: fora_dre (composição pendente), imposto em linha própria, mapa inválido ──
describe('classificarLinhaDRE — fora_dre (fase 2)', () => {
  const mapa = M([['2.05.03', 'fora_dre'], ['2.07', 'fora_dre'], ['2.06.01', 'ded_icms'], ['2.06', 'despesas_administrativas']]);
  const cls = (cod: string, regime: 'presumido' | 'simples' = 'presumido', m = mapa) =>
    classificarLinhaDRE({ categoria_codigo: cod, categoria_descricao: cod, isReceita: false, regime, mapping: m });

  it('código EXATO mapeado fora_dre sai do DRE e conta como mapeado', () => {
    const r = cls('2.05.03');
    expect(r.linha).toBe('fora_dre');
    expect(r.mapeado).toBe(true);
    expect(r.mapeamentoInvalido).toBeNull();
  });

  it('fora_dre NÃO é herdado por prefixo: filho novo de 2.07 fica sem mapa (heurística)', () => {
    const r = cls('2.07.88');
    expect(r.linha).toBe('despesas_operacionais');
    expect(r.mapeado).toBe(false);
    expect(r.viaFallback).toBe(true);
  });

  it('imposto em linha própria por código exato; filho do imposto não herda', () => {
    expect(cls('2.06.01').linha).toBe('ded_icms');
    expect(cls('2.06.01').mapeado).toBe(true);
    const filho = cls('2.06.01.07');
    expect(filho.mapeado).toBe(false);
    expect(filho.linha).not.toBe('ded_icms');
  });

  it('linha herdável segue herdando (2.06.50 ← 2.06 administrativas)', () => {
    const r = cls('2.06.50');
    expect(r.linha).toBe('despesas_administrativas');
    expect(r.mapeado).toBe(true);
  });

  it('valor desconhecido no mapa NÃO vira mapeado:true nem sobe ao ancestral válido', () => {
    const r = cls('2.06.77', 'presumido', M([['2.06.77', 'linha_que_nao_existe'], ['2.06', 'despesas_administrativas']]));
    expect(r.mapeado).toBe(false);
    expect(r.viaFallback).toBe(true);
    expect(r.mapeamentoInvalido).toEqual({ codigo: '2.06.77', valor: 'linha_que_nao_existe', origem: 'exato', motivo: 'valor_desconhecido' });
  });

  it('IRPJ/CSLL mapeado no Simples é inválido por regime (sumiria do resultado)', () => {
    const r = cls('2.06.05', 'simples', M([['2.06.05', 'irpj']]));
    expect(r.mapeado).toBe(false);
    expect(r.mapeamentoInvalido?.motivo).toBe('regime');
    expect(cls('2.06.05', 'presumido', M([['2.06.05', 'irpj']])).linha).toBe('irpj');
  });
});

describe('montarDRE — fora_dre não entra em subtotal e imposto vai para deduções (fase 2)', () => {
  it('fora_dre nos totais não altera nenhuma linha; ICMS/PIS/COFINS saem das operacionais', () => {
    const base = { receita_bruta: 100000, cmv: 40000, despesas_operacionais: 20000 };
    const antes = montarDRE({ regime: 'presumido', totais: tot(base) });
    const depois = montarDRE({ regime: 'presumido', totais: tot({ ...base, fora_dre: 50000 }) });
    expect(depois).toEqual(antes);
    const comImposto = montarDRE({ regime: 'presumido', totais: tot({ ...base, ded_icms: 4700, ded_pis: 240, ded_cofins: 125 }) });
    expect(comImposto.deducoes).toBe(5065);
    expect(comImposto.despesas_operacionais).toBe(20000);
    expect(comImposto.resultado_liquido).toBe(antes.resultado_liquido - 5065);
  });
});

describe('acumularForaDRE / aplicarPendenciasConfianca (fase 2)', () => {
  it('pendência = existe lançamento ≠ 0, mesmo quando a soma líquida zera', () => {
    const acc = novoForaDRE();
    acumularForaDRE(acc, '2.05.03', 1000, false);
    acumularForaDRE(acc, '2.05.03', -1000, false);
    expect(acc.saidas).toBe(0);
    expect(acc.composicao_pendente).toBe(true);
    expect(acc.por_codigo['2.05.03']).toEqual({ saidas: 0, entradas: 0 });
  });

  it('lançamento só negativo (estorno) também deixa a composição pendente', () => {
    const acc = novoForaDRE();
    acumularForaDRE(acc, '2.06.90', -500, false);
    expect(acc.composicao_pendente).toBe(true);
    expect(acc.saidas).toBe(-500);
  });

  it('só lançamentos zerados não geram pendência; entrada e saída ficam separadas', () => {
    const acc = novoForaDRE();
    acumularForaDRE(acc, '2.07.01', 0, false);
    expect(acc.composicao_pendente).toBe(false);
    acumularForaDRE(acc, '1.09.01', 300, true);
    expect(acc.entradas).toBe(300);
    expect(acc.saidas).toBe(0);
    expect(acc.composicao_pendente).toBe(true);
  });

  it('pendência rebaixa para baixa com motivo de resultado provisório; sem pendência não mexe', () => {
    const alta = scoreConfianca({ pct_mapeado_valor: 1, fallback_pct: 0, share_generico: 0, tem_imposto_nao_mapeado: false });
    const acc = novoForaDRE();
    expect(aplicarPendenciasConfianca(alta, { foraDRE: acc, mapeamentosInvalidos: 0, regime: 'caixa' })).toEqual(alta);
    acumularForaDRE(acc, '2.05.03', 191421.87, false);
    const r = aplicarPendenciasConfianca(alta, { foraDRE: acc, mapeamentosInvalidos: 0, regime: 'caixa' });
    expect(r.nivel).toBe('baixa');
    expect(r.motivos.join(' ')).toContain('resultado provisório');
  });

  it('mapa inválido rebaixa para baixa mesmo sem fora_dre', () => {
    const alta = scoreConfianca({ pct_mapeado_valor: 1, fallback_pct: 0, share_generico: 0, tem_imposto_nao_mapeado: false });
    const r = aplicarPendenciasConfianca(alta, { foraDRE: novoForaDRE(), mapeamentosInvalidos: 2, regime: 'competencia' });
    expect(r.nivel).toBe('baixa');
    expect(r.motivos.join(' ')).toContain('inválido');
  });
});

describe('linhasDreMapeaveis (tela de mapeamento, fase 2)', () => {
  it('_default: nunca fora_dre/nao_resultado nem imposto específico (vale para a empresa do Simples também)', () => {
    const l = linhasDreMapeaveis('_default');
    expect(l).not.toContain('fora_dre');
    expect(l).not.toContain('nao_resultado');
    expect(l).not.toContain('irpj');
    expect(l).not.toContain('das');
    expect(l).toContain('impostos');
  });
  it('presumido (colacor): específicos + fora_dre + nao_resultado; DAS só pelo histórico do Simples', () => {
    const l = linhasDreMapeaveis('colacor');
    expect(l).toEqual(expect.arrayContaining(['ded_icms', 'ded_pis', 'ded_cofins', 'ded_iss', 'ded_ipi', 'irpj', 'csll', 'fora_dre', 'nao_resultado']));
    // a colacor foi do Simples até 2022: o DAS daqueles anos é dedução legítima (o motor honra 'das' em qualquer regime)
    expect(l).toContain('das');
  });
  it('Simples (colacor_sc): DAS + fora_dre, sem IRPJ/CSLL', () => {
    const l = linhasDreMapeaveis('colacor_sc');
    expect(l).toContain('das');
    expect(l).toContain('fora_dre');
    expect(l).toContain('nao_resultado');
    expect(l).toContain('ded_icms'); // ICMS ST/DIFAL recolhido fora do DAS
    expect(l).not.toContain('irpj');
    expect(l).not.toContain('csll');
  });
  it('tudo que a tela oferece o motor honra (nenhuma linha vira mapa inválido)', () => {
    for (const c of ['_default', 'colacor', 'oben', 'colacor_sc']) {
      const regime = c === 'colacor_sc' ? 'simples' : 'presumido';
      for (const linha of linhasDreMapeaveis(c)) {
        const r = classificarLinhaDRE({ categoria_codigo: '9.01', categoria_descricao: '', isReceita: false, regime, mapping: M([['9.01', linha]]) });
        expect(r.mapeamentoInvalido, `${c}/${linha}`).toBeNull();
      }
    }
  });
});

describe('consolidado fase 2 (provisório tri-state, fora_dre parcial)', () => {
  it('provisório: true vence; todos false ⇒ false; NULL no meio ⇒ null (não vira false)', () => {
    expect(provisorioConsolidado([false, true, null])).toBe(true);
    expect(provisorioConsolidado([false, false])).toBe(false);
    expect(provisorioConsolidado([false, null])).toBeNull();
    expect(provisorioConsolidado([])).toBeNull();
  });
  it('fora_dre: soma conhecidos, marca parcial; todos ausentes ⇒ null (ausente ≠ 0)', () => {
    expect(foraDreConsolidado([100, 50])).toEqual({ valor: 150, parcial: false });
    expect(foraDreConsolidado([100, null])).toEqual({ valor: 100, parcial: true });
    expect(foraDreConsolidado([null, undefined])).toEqual({ valor: null, parcial: true });
  });
});

describe('nao_resultado (v1.13) — patrimonial definitivo, sem pendência', () => {
  const cls = (cod: string, m: Map<string, string>, isReceita = false) =>
    classificarLinhaDRE({ categoria_codigo: cod, categoria_descricao: cod, isReceita, regime: 'presumido', mapping: m });

  it('código EXATO nao_resultado é mapeado e válido', () => {
    const r = cls('1.04.04', M([['1.04.04', 'nao_resultado']]), true);
    expect(r.linha).toBe('nao_resultado');
    expect(r.mapeado).toBe(true);
    expect(r.mapeamentoInvalido).toBeNull();
  });

  it('NÃO é herdado por prefixo: filho novo de 2.07 fica sem mapa', () => {
    const r = cls('2.07.88', M([['2.07', 'nao_resultado']]));
    expect(r.linha).not.toBe('nao_resultado');
    expect(r.mapeado).toBe(false);
  });

  it('montarDRE ignora nao_resultado em todo subtotal', () => {
    const base = { receita_bruta: 100000, cmv: 40000, despesas_operacionais: 20000 };
    const antes = montarDRE({ regime: 'presumido', totais: tot(base) });
    const depois = montarDRE({ regime: 'presumido', totais: tot({ ...base, nao_resultado: 70000 }) });
    expect(depois).toEqual(antes);
  });

  it('acumula entradas/saídas por código e NÃO cria pendência nem rebaixa a confiança', () => {
    const acc = novoNaoResultado();
    acumularNaoResultado(acc, '1.04.04', 7213, true);
    acumularNaoResultado(acc, '2.07.02', 100, false);
    acumularNaoResultado(acc, '2.07.02', 50, false);
    expect(acc).toEqual({ entradas: 7213, saidas: 150, por_codigo: { '1.04.04': { entradas: 7213, saidas: 0 }, '2.07.02': { entradas: 0, saidas: 150 } } });
    const alta = scoreConfianca({ pct_mapeado_valor: 1, fallback_pct: 0, share_generico: 0, tem_imposto_nao_mapeado: false });
    // a pendência é só do fora_dre: um aporte puro não deixa o resultado provisório
    expect(aplicarPendenciasConfianca(alta, { foraDRE: novoForaDRE(), mapeamentosInvalidos: 0, regime: 'competencia' })).toEqual(alta);
  });

  it('heurística nunca devolve nao_resultado (sair do resultado é decisão explícita)', () => {
    for (const d of ['APORTE DE CAPITAL', 'COMPRA DE IMOBILIZADO', 'TRANSFERENCIA']) {
      const r = classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: d, isReceita: false, regime: 'presumido', mapping: M([]) });
      expect(r.linha).not.toBe('nao_resultado');
    }
  });
});

describe('v1.13 — a EDGE de fato roteia nao_resultado (gate textual: o helper isolado não prova o laço)', () => {
  // Codex adversarial 2026-11-22: remover a chamada real no laço `processar` mantinha esta suíte verde.
  const fonte = readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-financeiro/index.ts'), 'utf8');
  it('o laço desvia nao_resultado para o acumulador (antes do else que soma em totais)', () => {
    // v1.17: fora_dre/nao_resultado num ramo próprio; `totais` só no else (com sinal por natureza).
    expect(fonte).toMatch(/if \(c\.linha === "fora_dre" \|\| c\.linha === "nao_resultado"\) \{[^}]*else acumularNaoResultado\(naoResultado, cod, val, isReceita\);\n\s*\} else \{[^}]*totais\[c\.linha\] = \(totais\[c\.linha\] \?\? 0\) \+ assinado;/);
  });
  it('v1.17: o laço soma em totais o valor COM SINAL por natureza e acumula a composição do CMV', () => {
    expect(fonte).toMatch(/const assinado = valorComSinal\(val, isReceita, c\.linha\);/);
    expect(fonte).toMatch(/if \(c\.linha === "cmv"\) \{\n\s*acumularComposicaoCmv\(composicaoCmv, val, isReceita\);/);
    expect(fonte).toMatch(/\n\s*composicao_cmv: composicaoCmv,\n/);
  });
  it('o snapshot publica detalhamento.nao_resultado', () => {
    expect(fonte).toMatch(/\n\s*nao_resultado: naoResultado,\n/);
  });
  it('a edge declara nao_resultado como válido e não-herdável (espelho do helper)', () => {
    expect(fonte).toMatch(/'fora_dre', 'nao_resultado',\n\s*\/\/ baldes legados/);
    expect(fonte).toMatch(/LINHAS_NAO_HERDAVEIS = new Set<string>\(\[\n\s*'fora_dre', 'nao_resultado',/);
  });
});

describe('regime por competência — a EDGE usa regimeVigente em todo ponto (gate textual)', () => {
  const fonte = readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-financeiro/index.ts'), 'utf8');
  it('a edge não tem mais o mapa fixo por empresa', () => {
    expect(fonte).not.toMatch(/REGIME_POR_EMPRESA/);
  });
  it('calcularDRE deriva o regime do (company, ano, mes) e passa a competência à config', () => {
    expect(fonte).toMatch(/const regimeTrib: RegimeTributario = regimeVigente\(company, ano, mes\);/);
    expect(fonte).toMatch(/normalizarConfigTributario\(company, [^\n]*, ano, mes\)/);
  });
  it('a edge declara a mesma transição da colacor que o helper (jan/2023)', () => {
    expect(fonte).toMatch(/colacor: \[\{ desde: null, regime: 'simples' \}, \{ desde: 202301, regime: 'presumido' \}\]/);
  });
});

describe('impostoTeoricoTotal — total do teórico sem dobrar nem fabricar zero', () => {
  it('presumido: usa o `total` gravado, não soma parcelas + total', () => {
    expect(impostoTeoricoTotal({ irpj: 400, csll: 360, pis: 650, cofins: 3000, total: 4410 })).toBe(4410);
  });
  it('simples com DAS desconhecido → null (indisponível), nunca 0', () => {
    expect(impostoTeoricoTotal({ das: null })).toBeNull();
    expect(impostoTeoricoTotal(null)).toBeNull();
  });
  it('simples com DAS → o próprio DAS', () => {
    expect(impostoTeoricoTotal({ das: 1234.5 })).toBe(1234.5);
  });
});
