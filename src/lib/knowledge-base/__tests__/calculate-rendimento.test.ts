import { describe, it, expect } from 'vitest';
import { calculateRendimento, type CalculateInput } from '../calculate-rendimento';

type Spec = CalculateInput['spec'];

function spec(over: Partial<Spec> = {}): Spec {
  return {
    product_name: 'Verniz X',
    rendimento_m2_por_litro: null,
    densidade_g_cm3: null,
    gramatura_g_m2_min: null,
    gramatura_g_m2_max: null,
    demaos_recomendadas: null,
    ...over,
  };
}

const DEMAOS_WARN = 'Demãos não informadas no boletim — assumindo 1.';
const DERIVADO_WARN = 'Rendimento derivado da densidade + gramatura (boletim não informa explicitamente).';
const INSUF_WARN = 'Spec sem rendimento, densidade ou gramatura — dados insuficientes pro cálculo.';

describe('calculateRendimento', () => {
  it('rendimento explícito: litros = area/rendimento × demãos', () => {
    const r = calculateRendimento({ spec: spec({ rendimento_m2_por_litro: 10, demaos_recomendadas: 2 }), areaM2: 100 });
    expect(r.demaos).toBe(2);
    expect(r.rendimentoM2PorLitro).toBe(10);
    expect(r.litrosNecessarios).toBe(20);
    expect(r.warnings).toEqual([]);
    expect(r.calculo).toContain('Rendimento do boletim: 10');
  });

  it('demaosOverride sobrepõe o spec (sem warning de demãos)', () => {
    const r = calculateRendimento({
      spec: spec({ rendimento_m2_por_litro: 10, demaos_recomendadas: 2 }),
      areaM2: 100,
      demaosOverride: 3,
    });
    expect(r.demaos).toBe(3);
    expect(r.litrosNecessarios).toBe(30);
    expect(r.warnings).not.toContain(DEMAOS_WARN);
  });

  it('sem demãos informadas → assume 1 e avisa', () => {
    const r = calculateRendimento({ spec: spec({ rendimento_m2_por_litro: 10 }), areaM2: 100 });
    expect(r.demaos).toBe(1);
    expect(r.litrosNecessarios).toBe(10);
    expect(r.warnings).toContain(DEMAOS_WARN);
  });

  it('deriva o rendimento de densidade + gramatura (média das pontas)', () => {
    const r = calculateRendimento({
      spec: spec({ densidade_g_cm3: 1.2, gramatura_g_m2_min: 100, gramatura_g_m2_max: 200, demaos_recomendadas: 1 }),
      areaM2: 80,
    });
    // média 150 g/m²; 1.2*1000 / 150 = 8 m²/L; litros = 80/8 * 1 = 10
    expect(r.rendimentoM2PorLitro).toBe(8);
    expect(r.litrosNecessarios).toBe(10);
    expect(r.warnings).toContain(DERIVADO_WARN);
    expect(r.calculo).toContain('Derivado');
  });

  it('deriva mesmo com só uma ponta de gramatura (usa a presente como média)', () => {
    const r = calculateRendimento({
      spec: spec({ densidade_g_cm3: 1.2, gramatura_g_m2_min: 120, demaos_recomendadas: 1 }),
      areaM2: 120,
    });
    expect(r.rendimentoM2PorLitro).toBe(10); // 1200/120
    expect(r.litrosNecessarios).toBe(12);
    expect(r.warnings).toContain(DERIVADO_WARN);
  });

  it('rendimento explícito 0/inválido cai pra derivação (não trata 0 como válido)', () => {
    const r = calculateRendimento({
      spec: spec({ rendimento_m2_por_litro: 0, densidade_g_cm3: 1.2, gramatura_g_m2_min: 150, demaos_recomendadas: 1 }),
      areaM2: 100,
    });
    expect(r.rendimentoM2PorLitro).toBe(8); // 1200/150
    expect(r.litrosNecessarios).toBeCloseTo(12.5, 5);
    expect(r.warnings).toContain(DERIVADO_WARN);
  });

  it('dados insuficientes → zeros + memória "Dados insuficientes"', () => {
    const r = calculateRendimento({ spec: spec({ demaos_recomendadas: 1 }), areaM2: 100 });
    expect(r.rendimentoM2PorLitro).toBe(0);
    expect(r.litrosNecessarios).toBe(0);
    expect(r.calculo).toBe('Dados insuficientes');
    expect(r.warnings).toContain(INSUF_WARN);
  });

  it('área 0 → 0 litros, sem warning, rendimento preservado', () => {
    const r = calculateRendimento({ spec: spec({ rendimento_m2_por_litro: 10, demaos_recomendadas: 1 }), areaM2: 0 });
    expect(r.litrosNecessarios).toBe(0);
    expect(r.rendimentoM2PorLitro).toBe(10);
    expect(r.warnings).toEqual([]);
  });
});
