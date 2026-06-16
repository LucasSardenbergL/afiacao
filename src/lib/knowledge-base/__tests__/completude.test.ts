import { describe, it, expect } from 'vitest';
import { camposFaltantes, relatorioCompletude, CAMPOS_IMPORTANTES } from '@/lib/knowledge-base/completude';

const cheio = Object.fromEntries(CAMPOS_IMPORTANTES.map((c) => [c, c.includes('substrato') ? ['mdf'] : 1]));

describe('camposFaltantes', () => {
  it('campo importante null → faltante', () => {
    expect(camposFaltantes({ ...cheio, catalisador_codigo: null, extraction_gaps: [] })).toContain('catalisador_codigo');
  });
  it('campo em extraction_gaps → faltante (mesmo não-null)', () => {
    expect(camposFaltantes({ ...cheio, extraction_gaps: ['validade_dias'] })).toContain('validade_dias');
  });
  it('array vazio → faltante', () => {
    expect(camposFaltantes({ ...cheio, substrato: [], extraction_gaps: [] })).toContain('substrato');
  });
  it('completo → []', () => {
    expect(camposFaltantes({ ...cheio, extraction_gaps: [] })).toEqual([]);
  });
});

describe('relatorioCompletude', () => {
  it('agrega por produto, ordena por nº de faltantes desc', () => {
    const r = relatorioCompletude([
      { product_code: 'A', product_name: 'A', ...cheio, catalisador_codigo: null, extraction_gaps: [] },
      { product_code: 'B', product_name: 'B', ...cheio, extraction_gaps: [] },
    ]);
    expect(r[0].product_code).toBe('A');
    expect(r[0].faltantes).toContain('catalisador_codigo');
    expect(r.find((x) => x.product_code === 'B')?.faltantes).toEqual([]);
  });
});
