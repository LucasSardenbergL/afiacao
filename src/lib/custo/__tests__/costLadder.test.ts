import { describe, it, expect } from 'vitest';
import {
  computeCostLadder,
  cmcPreferido,
  type CostLadderConfig,
  type CostLadderInput,
} from '@/lib/custo/costLadder';

// Config canônica (defaults de recommendation_config em prod: 0.35 / 0.05 / 0.85).
// Faixa de sanidade do CMC com price=100 → custo plausível ∈ (price*0.15, price*0.95) = (15, 95).
const cfg: CostLadderConfig = { margemDefault: 0.35, margemMin: 0.05, margemMax: 0.85 };

function input(partial: Partial<CostLadderInput>): CostLadderInput {
  return { price: 100, cmc: null, familyTargetMargin: null, cfg, ...partial };
}

describe('computeCostLadder — Priority 1: CMC (única fonte de custo REAL)', () => {
  it('CMC válido vira fonte CMC, confiança alta, e SEMEIA cost_price com o CMC real', () => {
    const r = computeCostLadder(input({ cmc: 60 }));
    expect(r.costSource).toBe('CMC');
    expect(r.costFinal).toBe(60);
    expect(r.costConfidence).toBeGreaterThanOrEqual(0.8);
    expect(r.costPriceToPersist).toBe(60); // custo real → persiste
  });

  it('CMC vence a família quando ambos existem', () => {
    const r = computeCostLadder(input({ cmc: 60, familyTargetMargin: 0.5 }));
    expect(r.costSource).toBe('CMC');
    expect(r.costPriceToPersist).toBe(60);
  });

  it('CMC fora da faixa de sanidade (margem negativa: cmc>price) NÃO é aceito como CMC', () => {
    // Limitação conhecida e INTENCIONAL nesta entrega: um CMC com margem implausível
    // (ex.: venda no prejuízo) é rejeitado e cai em proxy. Documentado como pendência.
    const r = computeCostLadder(input({ cmc: 120 }));
    expect(r.costSource).not.toBe('CMC');
  });

  it('bordas estritas do sanity: cmc == price*(1-margemMin) e == price*(1-margemMax) são rejeitados', () => {
    expect(computeCostLadder(input({ cmc: 95 })).costSource).not.toBe('CMC'); // == 100*0.95
    expect(computeCostLadder(input({ cmc: 15 })).costSource).not.toBe('CMC'); // == 100*0.15
  });

  it('cmc=0 e cmc=null são tratados como AUSENTE (não como custo zero)', () => {
    expect(computeCostLadder(input({ cmc: 0 })).costSource).not.toBe('CMC');
    expect(computeCostLadder(input({ cmc: null })).costSource).not.toBe('CMC');
  });
});

describe('computeCostLadder — Priority 2/3: proxies (NUNCA semeiam cost_price)', () => {
  it('família com margem plausível → FAMILY_MARGIN_PROXY, cost_price NÃO é semeado (null)', () => {
    const r = computeCostLadder(input({ familyTargetMargin: 0.4 }));
    expect(r.costSource).toBe('FAMILY_MARGIN_PROXY');
    expect(r.costFinal).toBeCloseTo(60, 6); // 100*(1-0.4)
    expect(r.costConfidence).toBeLessThan(0.8);
    expect(r.costPriceToPersist).toBeNull(); // INVARIANTE: proxy nunca vira semente
  });

  it('sem família suficiente → DEFAULT_PROXY, cost_price null', () => {
    const r = computeCostLadder(input({ familyTargetMargin: null }));
    expect(r.costSource).toBe('DEFAULT_PROXY');
    expect(r.costFinal).toBeCloseTo(65, 6); // 100*(1-0.35)
    expect(r.costPriceToPersist).toBeNull();
  });

  it('margem de família fora da faixa (absurda) cai para DEFAULT_PROXY', () => {
    expect(computeCostLadder(input({ familyTargetMargin: 0.9 })).costSource).toBe('DEFAULT_PROXY');
    expect(computeCostLadder(input({ familyTargetMargin: 0.01 })).costSource).toBe('DEFAULT_PROXY');
  });
});

describe('computeCostLadder — anti-lavagem (o bug que estamos matando)', () => {
  it('NUNCA emite PRODUCT_COST a partir desta escada (não há writer real hoje)', () => {
    const inputs: CostLadderInput[] = [
      input({ cmc: 60 }),
      input({ cmc: null, familyTargetMargin: 0.4 }),
      input({ cmc: null, familyTargetMargin: null }),
      input({ cmc: 0, familyTargetMargin: 0.4 }),
      input({ cmc: 120 }),
    ];
    for (const i of inputs) {
      expect(computeCostLadder(i).costSource).not.toBe('PRODUCT_COST');
    }
  });

  it('idempotência entre runs: SKU sem CMC continua proxy em toda run (não há promoção a real)', () => {
    const i = input({ cmc: null, familyTargetMargin: 0.4 });
    const run1 = computeCostLadder(i);
    // run2 recebe o MESMO mundo (cmc continua ausente). Como o helper não lê
    // cost_price legado como fonte, é impossível promover proxy→PRODUCT_COST.
    const run2 = computeCostLadder(i);
    expect(run2).toEqual(run1);
    expect(run2.costSource).toBe('FAMILY_MARGIN_PROXY');
    expect(run2.costPriceToPersist).toBeNull();
  });

  it('todo resultado proxy tem costPriceToPersist === null (invariante global)', () => {
    for (let m = 0.06; m < 0.85; m += 0.07) {
      const r = computeCostLadder(input({ cmc: null, familyTargetMargin: m }));
      if (r.costSource !== 'CMC') expect(r.costPriceToPersist).toBeNull();
    }
  });
});

describe('computeCostLadder — guard money-path (price degenerado)', () => {
  it('price inválido (0/NaN/Infinity/negativo) → UNKNOWN, costFinal 0, sem semear', () => {
    for (const price of [0, -5, NaN, Infinity]) {
      const r = computeCostLadder(input({ price, cmc: 60, familyTargetMargin: 0.4 }));
      expect(r.costSource).toBe('UNKNOWN');
      expect(r.costFinal).toBe(0);
      expect(r.costConfidence).toBe(0);
      expect(r.costPriceToPersist).toBeNull();
    }
  });
});

describe('cmcPreferido — preserva CMC real persistido (Codex review P1)', () => {
  it('usa o CMC atual quando > 0', () => {
    expect(cmcPreferido(50, 30)).toBe(50);
  });
  it('cai para o persistido quando o atual é 0/null/undefined (0 = posição sem custo, não custo zero)', () => {
    expect(cmcPreferido(0, 30)).toBe(30);
    expect(cmcPreferido(null, 30)).toBe(30);
    expect(cmcPreferido(undefined, 30)).toBe(30);
  });
  it('null quando ambos ausentes/zerados (sem custo real → escada degrada honestamente)', () => {
    expect(cmcPreferido(0, 0)).toBeNull();
    expect(cmcPreferido(null, null)).toBeNull();
    expect(cmcPreferido(undefined, undefined)).toBeNull();
  });
  it('ignora valores negativos (custo inválido)', () => {
    expect(cmcPreferido(-5, 30)).toBe(30);
    expect(cmcPreferido(-5, -2)).toBeNull();
  });
});
