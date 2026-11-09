import { describe, expect, it } from 'vitest';
import {
  guardrailFillRate, normalizarSemanaPedidos, normalizarSemanaPrateleira, pct, semanaDe, variacaoFillRatePp, type SemanaPedidos,
} from '@/lib/financeiro/ruptura-sensor-helpers';

const linha = (o: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  empresa: 'oben', semana: '2026-10-26', itens_registrados: 120, itens_importados: 130, pedidos: 40,
  itens_atendiveis: 100, itens_ruptura: 10, itens_indeterminados: 6, itens_sem_leitura: 4,
  fill_rate_pct: 90.9, cobertura_pct: 92.3, ...o,
});
const sem = (semana: string, fillRatePct: number | null): SemanaPedidos => ({
  semana, itensRegistrados: 50, itensImportados: 50, pedidos: 10, atendiveis: 40, ruptura: 5, indeterminados: 3, semLeitura: 2,
  fillRatePct, coberturaPct: 100,
});

describe('normalizarSemanaPedidos — ausente ≠ zero', () => {
  it('converte a linha da view', () => {
    expect(normalizarSemanaPedidos(linha())).toEqual({
      semana: '2026-10-26', itensRegistrados: 120, itensImportados: 130, pedidos: 40, atendiveis: 100, ruptura: 10,
      indeterminados: 6, semLeitura: 4, fillRatePct: 90.9, coberturaPct: 92.3,
    });
  });
  it('fill_rate e cobertura ausentes ficam null (nunca 0)', () => {
    const s = normalizarSemanaPedidos(linha({ fill_rate_pct: null, cobertura_pct: null, itens_importados: null }));
    expect(s?.fillRatePct).toBeNull();
    expect(s?.coberturaPct).toBeNull();
    expect(s?.itensImportados).toBeNull();
  });
  it('linha sem chave ou sem contagem é descartada', () => {
    expect(normalizarSemanaPedidos(linha({ semana: null }))).toBeNull();
    expect(normalizarSemanaPedidos(linha({ itens_ruptura: 'x' }))).toBeNull();
    expect(normalizarSemanaPedidos(linha({ empresa: 'colacor' }))).toBeNull();
  });
});

describe('normalizarSemanaPrateleira', () => {
  it('converte e preserva null', () => {
    expect(normalizarSemanaPrateleira({ empresa: 'oben', semana: '2026-10-26', dias_lidos: 3, ultimo_dia: '2026-10-28', pct_skus_sem_saldo: 10.8, pct_valor_sem_saldo: null, pct_skus_sem_leitura: 14.1, skus_com_venda_90d: 361 }))
      .toEqual({ semana: '2026-10-26', diasLidos: 3, ultimoDia: '2026-10-28', pctSkusSemSaldo: 10.8, pctValorSemSaldo: null, pctSkusSemLeitura: 14.1, skusComVenda90d: 361 });
    expect(normalizarSemanaPrateleira({ empresa: 'oben', semana: '2026-10-26', dias_lidos: null })).toBeNull();
  });
});

describe('semanaDe', () => {
  it('segunda-feira ISO da semana', () => {
    expect(semanaDe('2026-10-31')).toBe('2026-10-26'); // sábado → segunda 26
    expect(semanaDe('2026-10-26')).toBe('2026-10-26'); // segunda
    expect(semanaDe('2026-11-01')).toBe('2026-10-26'); // domingo ainda é a semana do dia 26
  });
});

describe('variacaoFillRatePp / guardrail', () => {
  it('compara as duas últimas semanas FECHADAS; a corrente (parcial) fica fora', () => {
    const serie = [sem('2026-10-12', 95), sem('2026-10-19', 93.5), sem('2026-10-26', 50)];
    const v = variacaoFillRatePp(serie, '2026-10-31');
    expect(v).toEqual({ de: '2026-10-12', para: '2026-10-19', pp: -1.5 });
    expect(guardrailFillRate(v)).toBe('queda');
  });
  it('queda de até 1 p.p. é estável; sem duas semanas fechadas com fill-rate não há veredito', () => {
    expect(guardrailFillRate(variacaoFillRatePp([sem('2026-10-12', 95), sem('2026-10-19', 94.2)], '2026-10-31'))).toBe('estavel');
    expect(variacaoFillRatePp([sem('2026-10-12', 95), sem('2026-10-19', null)], '2026-10-31')).toBeNull();
    expect(variacaoFillRatePp([sem('2026-10-26', 95)], '2026-10-31')).toBeNull();
    expect(guardrailFillRate(null)).toBeNull();
  });
  it('pct formata pt-BR e ausente vira travessão', () => {
    expect(pct(90.94)).toBe('90,9%');
    expect(pct(null)).toBe('—');
  });
});
