import { describe, expect, it } from 'vitest';
import type { Json, Tables } from '@/integrations/supabase/types';
import { lerComposicaoDespesas, lerDetalhamentoDre, paraFinDRE } from './dre-borda';

// Formas reais de prod (psql-ro, 2026-10-20): snapshot legado só com receitas/despesas/categorias
// (42 linhas), snapshot Onda 3a com impostos/confiança (91) e fase 2 com fora_dre/composição (58).
const DETALHAMENTO_FASE2: Json = {
  receitas: { '1.01.01': 1000 },
  despesas: { '2.01.01': 300, '2.03.01': 120 },
  categorias_nao_mapeadas: ['9.99'],
  impostos: { ded_icms: 18, ded_pis: 1.65, ded_cofins: 7.6 },
  regime_tributario: 'presumido',
  caixa_estimado: false,
  confianca: { nivel: 'baixa', motivos: ['fallback'], pct_mapeado_valor: 0.8, fallback_pct: 0.2 },
  imposto_teorico: { irpj: 10, csll: 9 },
  delta_imposto_pct: null,
  config_tributaria_completa: true,
  fora_dre: {
    saidas: 50, entradas: 0, lancamentos_nao_zero: 2,
    por_codigo: { '3.01': { saidas: 50, entradas: 0 } },
    composicao_pendente: false, motivo: null,
  },
  mapeamentos_invalidos: [],
  composicao_despesas: { '2.01.01': { despesas_operacionais: 300 } },
  contrato: { versao: 2 },
};

function linha(over: Partial<Tables<'fin_dre_snapshots'>> = {}): Tables<'fin_dre_snapshots'> {
  return {
    id: 'snap-1', company: 'oben', ano: 2026, mes: 9, regime: 'competencia', calculated_at: null,
    receita_bruta: 1000, deducoes: 27.25, receita_liquida: 972.75, cmv: 400, lucro_bruto: 572.75,
    despesas_operacionais: 300, despesas_administrativas: 0, despesas_comerciais: 0, despesas_financeiras: 0,
    receitas_financeiras: 0, resultado_operacional: 272.75, outras_receitas: 0, outras_despesas: 0,
    resultado_antes_impostos: 272.75, impostos: 19, resultado_liquido: 253.75,
    fora_dre: 50, resultado_provisorio: false, qtd_categorias_sem_mapeamento: 1,
    detalhamento: DETALHAMENTO_FASE2,
    ...over,
  };
}

describe('paraFinDRE', () => {
  it('linha válida: preserva os valores e as demais colunas (como o cast antigo deixava passar)', () => {
    const d = paraFinDRE(linha());
    expect(d.receita_bruta).toBe(1000);
    expect(d.resultado_liquido).toBe(253.75);
    expect(d.regime).toBe('competencia');
    expect(d.fora_dre).toBe(50);
    expect(d.detalhamento.despesas).toEqual({ '2.01.01': 300, '2.03.01': 120 });
    expect(d.detalhamento.fora_dre?.motivo).toBeNull();
    expect(d).toMatchObject({ id: 'snap-1', qtd_categorias_sem_mapeamento: 1 });
  });

  it('coluna numérica NULL LANÇA — nunca vira 0 numa DRE', () => {
    expect(() => paraFinDRE(linha({ cmv: null }))).toThrow(
      'fin_dre_snapshots oben 2026-9 (competencia): coluna "cmv" veio nula — linha inválida, não entra',
    );
  });

  it('regime fora de caixa|competencia LANÇA', () => {
    expect(() => paraFinDRE(linha({ regime: 'gerencial' }))).toThrow('.regime: valor fora do vocabulário "gerencial"');
  });

  it('detalhamento NULL LANÇA (o tipo promete receitas/despesas)', () => {
    expect(() => paraFinDRE(linha({ detalhamento: null }))).toThrow('.detalhamento: esperava objeto, veio null');
  });
});

describe('lerDetalhamentoDre', () => {
  it('snapshot legado: chaves opcionais ausentes continuam AUSENTES', () => {
    const d = lerDetalhamentoDre({ receitas: {}, despesas: { '2.01': 5 }, categorias_nao_mapeadas: [] }, 'd');
    expect(d).toEqual({ receitas: {}, despesas: { '2.01': 5 }, categorias_nao_mapeadas: [] });
    expect('impostos' in d).toBe(false);
    expect('fora_dre' in d).toBe(false);
  });

  it('chave extra do writer (composicao_*, contrato) é ignorada; imposto desconhecido não entra', () => {
    const d = lerDetalhamentoDre({ ...(DETALHAMENTO_FASE2 as object), impostos: { ded_icms: 1, novo: 2 } }, 'd');
    expect(d.impostos).toEqual({ ded_icms: 1 });
    expect('contrato' in d).toBe(false);
  });

  it('despesa com valor string LANÇA (era `Number(v)` que fabricava)', () => {
    expect(() => lerDetalhamentoDre({ receitas: {}, despesas: { '2.01': '5' } }, 'd')).toThrow(
      'd.despesas.2.01: esperava número, veio string',
    );
  });

  it('receitas ausente LANÇA', () => {
    expect(() => lerDetalhamentoDre({ despesas: {} }, 'd')).toThrow('d.receitas: esperava objeto, veio ausente');
  });

  it('aninhados com tipo trocado LANÇAM', () => {
    const base = { receitas: {}, despesas: {} };
    expect(() =>
      lerDetalhamentoDre({ ...base, confianca: { nivel: 'otima', motivos: [], pct_mapeado_valor: 1, fallback_pct: 0 } }, 'd'),
    ).toThrow('d.confianca.nivel: valor fora do vocabulário "otima"');
    expect(() =>
      lerDetalhamentoDre({ ...base, fora_dre: { saidas: 1, entradas: 0, por_codigo: {}, composicao_pendente: 'nao', motivo: null } }, 'd'),
    ).toThrow('d.fora_dre.composicao_pendente: esperava booleano, veio string');
    expect(() => lerDetalhamentoDre({ ...base, imposto_teorico: { irpj: '1' } }, 'd')).toThrow(
      'd.imposto_teorico.irpj: esperava número, veio string',
    );
    expect(() =>
      lerDetalhamentoDre({ ...base, mapeamentos_invalidos: [{ codigo: '1', valor: 'x', origem: 'outro', motivo: 'm', codigo_titulo: 't', valor_afetado: 1 }] }, 'd'),
    ).toThrow('d.mapeamentos_invalidos[0].origem: valor fora do vocabulário "outro"');
  });

  it('NULL onde o tipo declara `| null` é contrato', () => {
    const d = lerDetalhamentoDre({ receitas: {}, despesas: {}, imposto_teorico: null, delta_imposto_pct: null }, 'd');
    expect(d.imposto_teorico).toBeNull();
    expect(d.delta_imposto_pct).toBeNull();
  });
});

describe('lerComposicaoDespesas', () => {
  it('ausente ou NULL ⇒ null (snapshot legado)', () => {
    expect(lerComposicaoDespesas(undefined)).toBeNull();
    expect(lerComposicaoDespesas(null)).toBeNull();
  });

  it('válida passa intacta', () => {
    expect(lerComposicaoDespesas({ '2.01': { cmv: 10, despesas_operacionais: 0 } })).toEqual({
      '2.01': { cmv: 10, despesas_operacionais: 0 },
    });
  });

  it('valor NULL, "" ou string numérica ⇒ objeto VAZIO (o helper rejeita); nunca 0 por coerção', () => {
    expect(lerComposicaoDespesas({ '2.01': { cmv: null } })).toEqual({});
    expect(lerComposicaoDespesas({ '2.01': { cmv: '' } })).toEqual({});
    expect(lerComposicaoDespesas({ '2.01': { cmv: '10' } })).toEqual({});
    expect(lerComposicaoDespesas({ '2.01': { cmv: 10 }, '2.02': 5 })).toEqual({});
    expect(lerComposicaoDespesas([1])).toEqual({});
  });
});
