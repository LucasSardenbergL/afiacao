import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  acumularComposicaoCmv, classificarLinhaDRE, novaComposicaoCmv, valorComSinal,
} from '@/lib/financeiro/dre-helpers';
import { cmvBrutoDeCompras } from '@/lib/financeiro/ponto-equilibrio-helpers';

describe('DRE v1.17 — sinal por natureza', () => {
  it('lado oposto subtrai; mesmo lado soma', () => {
    expect(valorComSinal(100, true, 'cmv')).toBe(-100);
    expect(valorComSinal(100, false, 'cmv')).toBe(100);
    expect(valorComSinal(100, false, 'receita_bruta')).toBe(-100);
    expect(valorComSinal(100, true, 'outras_receitas')).toBe(100);
  });

  it('composição versionada do CMV: líquido = compras − devoluções', () => {
    const c = novaComposicaoCmv();
    acumularComposicaoCmv(c, 1000, false);
    acumularComposicaoCmv(c, 191, true);
    expect(c).toEqual({ versao: 'cmv-v1', compras: 1000, devolucoes_compra: 191, liquido: 809 });
  });

  it('heurística: CR "devolução de compra" vai ao CMV (redutora); devolução de venda segue em deduções', () => {
    const base = { categoria_codigo: '', isReceita: true, regime: 'presumido' as const, mapping: new Map<string, string>() };
    expect(classificarLinhaDRE({ ...base, categoria_descricao: 'Devoluções de Compra de Mercadoria' }).linha).toBe('cmv');
    expect(classificarLinhaDRE({ ...base, categoria_descricao: 'Devolução de Vendas' }).linha).toBe('deducoes');
  });

  it('espelho VERBATIM da edge (sinal-natureza.ts)', () => {
    const norm = (s: string) => s.replace(/\s+/g, '');
    const edge = norm(readFileSync('supabase/functions/omie-financeiro/sinal-natureza.ts', 'utf8'));
    const helper = norm(readFileSync('src/lib/financeiro/dre-helpers.ts', 'utf8'));
    const ini = edge.indexOf('constLINHAS_CREDORAS');
    expect(ini).toBeGreaterThan(-1);
    const corpo = edge.slice(ini).replace(/\/\*\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, '');
    expect(helper.replace(/\/\*\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, '')).toContain(corpo);
  });
});

describe('PE usa o CMV bruto de compras', () => {
  it('soma a devolução de volta; ausente = cmv como está', () => {
    expect(cmvBrutoDeCompras(809, { versao: 'cmv-v1', compras: 1000, devolucoes_compra: 191, liquido: 809 })).toBe(1000);
    expect(cmvBrutoDeCompras(809, null)).toBe(809);
    expect(cmvBrutoDeCompras(809, undefined)).toBe(809);
  });
  it('contrato desconhecido ou número inválido LANÇA (nunca adivinha)', () => {
    expect(() => cmvBrutoDeCompras(1, { versao: 'cmv-v2', devolucoes_compra: 1 })).toThrow(/contrato desconhecido/);
    expect(() => cmvBrutoDeCompras(1, { versao: 'cmv-v1' })).toThrow(/devolucoes_compra ausente/);
  });
});
