import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { custoValido, custoCanonico, margemUnitaria } from '@/lib/custo/custoCanonico';

describe('custoValido — ausente≠zero', () => {
  it('aceita número positivo finito', () => {
    expect(custoValido(12.5)).toBe(12.5);
  });
  it('converte string numérica', () => {
    expect(custoValido('12.5')).toBe(12.5);
  });
  it('rejeita 0, negativo, NaN, Infinity, null, undefined, string vazia → null (NUNCA 0)', () => {
    for (const x of [0, -3, NaN, Infinity, null, undefined, '', 'abc'] as const) {
      expect(custoValido(x)).toBeNull();
    }
  });
});

describe('custoCanonico — cost_final preferido, fallback cost_price real', () => {
  it('usa cost_final quando válido', () => {
    expect(custoCanonico({ cost_final: 8, cost_price: 5 })).toBe(8);
  });
  it('cai para cost_price quando cost_final é ausente/inválido', () => {
    expect(custoCanonico({ cost_final: null, cost_price: 5 })).toBe(5);
    expect(custoCanonico({ cost_final: 0, cost_price: 5 })).toBe(5);
  });
  it('null quando AMBOS ausentes/inválidos (SKU sem custo → excluir, não margem 100%)', () => {
    expect(custoCanonico({ cost_final: null, cost_price: null })).toBeNull();
    expect(custoCanonico({ cost_final: 0, cost_price: 0 })).toBeNull();
    expect(custoCanonico({})).toBeNull();
  });
});

describe('margemUnitaria — custo ausente NÃO vira margem cheia', () => {
  it('calcula preço - custo quando o custo é conhecido', () => {
    expect(margemUnitaria(100, 60)).toBe(40);
  });

  it('custo ausente (costMap sem o SKU) → null, e a margem NUNCA é igual ao preço', () => {
    for (const semCusto of [undefined, null] as const) {
      const m = margemUnitaria(100, semCusto);
      expect(m).toBeNull();
      // O ponto do bug: com `costMap.get(id) || 0` isto daria 100 (margem 100%) e o SKU
      // sem custo SUBIA no ranking, porque todo engine filtra só `margin <= 0`.
      expect(m).not.toBe(100);
    }
  });

  it('margem negativa é preservada (custo > preço é dado REAL, não ausência)', () => {
    expect(margemUnitaria(50, 80)).toBe(-30);
  });
});

// ── Invariante textual: o CONSUMO do costMap nos engines não pode fabricar custo 0 ──
// Por que textual: o bug não está no cálculo isolado, está no ponto de LEITURA do map — a
// montagem já excluía o SKU sem custo (custoCanonico → null), e o consumo reintroduzia o zero
// com `costMap.get(id) || 0`. O helper acima não impede alguém de escrever `|| 0` de novo no
// hook; este teste impede. Mesmo idioma de src/__tests__/edge-money-path-invariants.test.ts.
const REPO = resolve(__dirname, '../../../..');
const ENGINES = [
  'src/hooks/useCrossSellEngine.ts',
  'src/hooks/useBundleEngine.ts',
  'src/hooks/useFarmerScoring.ts',
];

describe('invariante: consumo do costMap não fabrica custo zero', () => {
  it.each(ENGINES)('%s não usa `costMap.get(...) || 0` nem `?? 0`', (rel) => {
    const src = readFileSync(resolve(REPO, rel), 'utf8');
    const fabricacoes = src.match(/costMap\.get\([^)]*\)\s*(\|\||\?\?)\s*0/g) ?? [];
    expect(fabricacoes).toEqual([]);
  });
});
