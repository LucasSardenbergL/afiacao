import { describe, it, expect } from 'vitest';
import { normalizeExtractedSpec } from '@/lib/knowledge-base/specs-types';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

/** Base mínima válida (todos os 7 arrays presentes). */
function base(over: Partial<KbExtractedSpec> = {}): KbExtractedSpec {
  return {
    product_code: 'FO20.6827.00',
    product_name: 'Verniz PU',
    supplier: 'sayerlack',
    product_line: null,
    product_category: null,
    densidade_g_cm3: null,
    solidos_pct: null,
    viscosidade_aplicacao_s: null,
    viscosidade_copo: null,
    brilho_ub: null,
    dureza: null,
    rendimento_m2_por_litro: null,
    demaos_recomendadas: null,
    gramatura_g_m2_min: null,
    gramatura_g_m2_max: null,
    pot_life_horas: null,
    temp_aplicacao_c_min: null,
    temp_aplicacao_c_max: null,
    umidade_aplicacao_pct_min: null,
    umidade_aplicacao_pct_max: null,
    catalisador_codigo: null,
    catalisador_proporcao_pct: null,
    diluente_codigo: null,
    equipamentos_aplicacao: [],
    lixa_recomendada: null,
    substrato: [],
    secagem_manuseio_h: null,
    secagem_empilhamento_h: null,
    secagem_total_h: null,
    validade_dias: null,
    temp_armazenamento_c_min: null,
    temp_armazenamento_c_max: null,
    certificacoes_aplicaveis: [],
    isento_metais_pesados: [],
    isento_substancias: [],
    diferenciais_chave: [],
    uso_recomendado: null,
    publico_alvo: null,
    extraction_confidence: 0.9,
    extraction_gaps: [],
    ...over,
  };
}

describe('normalizeExtractedSpec', () => {
  it('mantém os arrays já presentes (incl. extraction_gaps)', () => {
    const r = normalizeExtractedSpec(
      base({ extraction_gaps: ['densidade'], substrato: ['madeira', 'mdf'] }),
    );
    expect(r.extraction_gaps).toEqual(['densidade']);
    expect(r.substrato).toEqual(['madeira', 'mdf']);
  });

  it('extraction_gaps AUSENTE (undefined) vira [] — o caso que derrubava a tela', () => {
    // simula o LLM omitindo o campo required (a API não garante a saída)
    const raw = base();
    delete (raw as Partial<KbExtractedSpec>).extraction_gaps;
    const r = normalizeExtractedSpec(raw);
    expect(r.extraction_gaps).toEqual([]);
    // o consumidor (RevisaoItem/KbSpecsForm) faz `.length` sem estourar:
    expect(() => r.extraction_gaps.length).not.toThrow();
  });

  it('todos os 7 arrays ausentes viram []', () => {
    const raw = base();
    for (const k of [
      'equipamentos_aplicacao', 'substrato', 'certificacoes_aplicaveis',
      'isento_metais_pesados', 'isento_substancias', 'diferenciais_chave', 'extraction_gaps',
    ] as const) {
      delete (raw as Partial<KbExtractedSpec>)[k];
    }
    const r = normalizeExtractedSpec(raw);
    expect(r.equipamentos_aplicacao).toEqual([]);
    expect(r.substrato).toEqual([]);
    expect(r.certificacoes_aplicaveis).toEqual([]);
    expect(r.isento_metais_pesados).toEqual([]);
    expect(r.isento_substancias).toEqual([]);
    expect(r.diferenciais_chave).toEqual([]);
    expect(r.extraction_gaps).toEqual([]);
  });

  it('valor não-array (string/objeto) vira [] (defensivo contra LLM)', () => {
    const raw = base();
    (raw as unknown as Record<string, unknown>).extraction_gaps = 'densidade';
    (raw as unknown as Record<string, unknown>).substrato = { a: 1 };
    const r = normalizeExtractedSpec(raw);
    expect(r.extraction_gaps).toEqual([]);
    expect(r.substrato).toEqual([]);
  });

  it('filtra itens não-string de dentro do array', () => {
    const raw = base();
    (raw as unknown as Record<string, unknown>).diferenciais_chave = ['ok', 2, null, 'bom'];
    const r = normalizeExtractedSpec(raw);
    expect(r.diferenciais_chave).toEqual(['ok', 'bom']);
  });

  it('preserva os campos não-array (product_code, confidence, nulls)', () => {
    const r = normalizeExtractedSpec(base({ product_code: 'WFOT.6529', extraction_confidence: 0.42 }));
    expect(r.product_code).toBe('WFOT.6529');
    expect(r.extraction_confidence).toBe(0.42);
    expect(r.rendimento_m2_por_litro).toBeNull();
  });
});
