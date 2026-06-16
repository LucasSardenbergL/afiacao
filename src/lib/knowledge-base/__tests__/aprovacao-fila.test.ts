import { describe, it, expect } from 'vitest';
import { classificarExtracao, particionarResultados, LIMIAR_AUTO_APROVACAO } from '../aprovacao-fila';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

/**
 * Factory auxiliar: preenche todos os campos obrigatórios (non-nullable)
 * do KbExtractedSpec e deixa o chamador sobrescrever só o que importa pro teste.
 */
const spec = (over: Partial<KbExtractedSpec> = {}): KbExtractedSpec => ({
  product_code: 'FO20.6827.00',
  product_name: 'x',
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
});

describe('classificarExtracao', () => {
  it("confiança ≥ limiar E com product_code → 'auto'", () => {
    expect(classificarExtracao(spec({ extraction_confidence: 0.9 }))).toBe('auto');
    expect(classificarExtracao(spec({ extraction_confidence: LIMIAR_AUTO_APROVACAO }))).toBe('auto');
  });

  it("confiança < limiar → 'revisar'", () => {
    expect(classificarExtracao(spec({ extraction_confidence: 0.5 }))).toBe('revisar');
  });

  it("sem product_code → 'revisar' (não dá pra salvar, NOT NULL)", () => {
    expect(classificarExtracao(spec({ product_code: '', extraction_confidence: 0.99 }))).toBe('revisar');
  });

  it('confiança nula/ausente → revisar (não fabrica certeza)', () => {
    expect(classificarExtracao(spec({ extraction_confidence: null }))).toBe('revisar');
  });
});

describe('particionarResultados', () => {
  it('separa auto vs revisar preservando o docId', () => {
    const r = particionarResultados([
      { documentId: 'd1', spec: spec({ extraction_confidence: 0.9 }) },
      { documentId: 'd2', spec: spec({ extraction_confidence: 0.4 }) },
      { documentId: 'd3', spec: spec({ product_code: '' }) },
    ]);
    expect(r.auto.map((x) => x.documentId)).toEqual(['d1']);
    expect(r.revisar.map((x) => x.documentId)).toEqual(['d2', 'd3']);
  });
});
