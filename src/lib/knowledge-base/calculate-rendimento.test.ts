import { describe, it, expect } from 'vitest';
import { calculateRendimento } from './calculate-rendimento';
import type { KbProductSpec } from './specs-types';

const spec = (overrides: Partial<KbProductSpec> = {}): KbProductSpec => ({
  id: 's1',
  document_id: null,
  product_code: 'TEST.001',
  product_name: 'Teste',
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
  extraction_confidence: null,
  extraction_gaps: [],
  extracted_by: null,
  approved_by: null,
  approved_at: null,
  created_at: '2026-05-17',
  updated_at: '2026-05-17',
  ...overrides,
});

describe('calculateRendimento', () => {
  it('usa rendimento explícito do spec', () => {
    const r = calculateRendimento({
      spec: spec({ rendimento_m2_por_litro: 8, demaos_recomendadas: 2 }),
      areaM2: 80,
    });
    expect(r.litrosNecessarios).toBeCloseTo(20, 1); // 80 / 8 * 2 = 20
    expect(r.rendimentoM2PorLitro).toBe(8);
    expect(r.demaos).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it('deriva rendimento de densidade + gramatura quando explícito ausente', () => {
    const r = calculateRendimento({
      spec: spec({ densidade_g_cm3: 0.979, gramatura_g_m2_min: 100, gramatura_g_m2_max: 150, demaos_recomendadas: 1 }),
      areaM2: 100,
    });
    // (0.979 * 1000) / 125 = ~7.83 m²/L
    expect(r.rendimentoM2PorLitro).toBeCloseTo(7.83, 1);
    expect(r.warnings).toContainEqual(expect.stringContaining('derivado'));
  });

  it('spec sem rendimento nem densidade/gramatura: warning + litros=0', () => {
    const r = calculateRendimento({ spec: spec({ demaos_recomendadas: 2 }), areaM2: 50 });
    expect(r.litrosNecessarios).toBe(0);
    expect(r.warnings).toContainEqual(expect.stringContaining('insuficientes'));
  });

  it('demaosOverride sobrescreve default do spec', () => {
    const r = calculateRendimento({
      spec: spec({ rendimento_m2_por_litro: 10, demaos_recomendadas: 1 }),
      areaM2: 100,
      demaosOverride: 3,
    });
    expect(r.demaos).toBe(3);
    expect(r.litrosNecessarios).toBeCloseTo(30, 1); // 100/10*3
  });

  it('sem demãos no spec nem override: assume 1 + warning', () => {
    const r = calculateRendimento({
      spec: spec({ rendimento_m2_por_litro: 8 }),
      areaM2: 80,
    });
    expect(r.demaos).toBe(1);
    expect(r.warnings).toContainEqual(expect.stringContaining('Demãos'));
  });

  it('cálculo realista: 80 m² × 2 demãos ÷ 8 m²/L = 20 L', () => {
    const r = calculateRendimento({
      spec: spec({ rendimento_m2_por_litro: 8, demaos_recomendadas: 2 }),
      areaM2: 80,
    });
    expect(r.litrosNecessarios).toBeCloseTo(20, 1);
  });
});
