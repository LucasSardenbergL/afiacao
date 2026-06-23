import { describe, it, expect } from 'vitest';
import {
  computeCostLadder,
  cmcPreferido,
  type CostLadderConfig,
  type CostLadderInput,
} from '@/lib/custo/costLadder';

// Config canônica (defaults de recommendation_config em prod: margens 0.35 / 0.05 / 0.85).
// Banda de margem plausível (price=100) → custo ∈ (15, 95): CLASSIFICA CMC normal vs atípico.
// Guard anti-lixo ABSOLUTO (price=100) → custo ∈ [1, 500]: rejeita só erro de dado (quase-zero/absurdo).
const cfg: CostLadderConfig = {
  margemDefault: 0.35, margemMin: 0.05, margemMax: 0.85, cmcRatioMin: 0.01, cmcRatioMax: 5,
};

function input(partial: Partial<CostLadderInput>): CostLadderInput {
  return { price: 100, cmc: null, familyTargetMargin: null, cfg, ...partial };
}

describe('computeCostLadder — Priority 1: CMC normal (banda de margem plausível)', () => {
  it('CMC na banda vira fonte CMC, confiança alta, e SEMEIA cost_price com o CMC real', () => {
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

  it('CMC perto das bordas internas da banda ainda é CMC normal (conf alta)', () => {
    expect(computeCostLadder(input({ cmc: 94 })).costSource).toBe('CMC'); // margem 6% (>min)
    expect(computeCostLadder(input({ cmc: 16 })).costSource).toBe('CMC'); // margem 84% (<max)
  });

  it('cmc=0 e cmc=null são tratados como AUSENTE (não como custo zero, não como atípico)', () => {
    for (const cmc of [0, null]) {
      const s = computeCostLadder(input({ cmc })).costSource;
      expect(s).not.toBe('CMC');
      expect(s).not.toBe('CMC_MARGEM_ATIPICA');
    }
  });
});

// O CORAÇÃO desta entrega (fecha a pendência (b) do #977): um CMC REAL fora da banda de margem
// plausível (prejuízo / margem baixa / margem alta) NÃO é mais mascarado por um proxy "bonito".
// Vira uma fonte REAL dedicada, de confiança rebaixada, que PRESERVA o custo real e o expõe.
describe('computeCostLadder — CMC_MARGEM_ATIPICA (margem real fora da banda, NÃO mascarada)', () => {
  it('margem NEGATIVA real (cmc>price, venda no prejuízo) → CMC_MARGEM_ATIPICA, preserva o custo real', () => {
    const r = computeCostLadder(input({ cmc: 120 }));
    expect(r.costSource).toBe('CMC_MARGEM_ATIPICA');
    expect(r.costFinal).toBe(120); // NÃO substitui por proxy: o prejuízo fica visível
    expect(r.costPriceToPersist).toBe(120); // custo real CMC-derivado → persiste
    expect(r.costConfidence).toBeCloseTo(0.6, 6);
  });

  it('margem exatamente zero (cmc==price) → atípica', () => {
    const r = computeCostLadder(input({ cmc: 100 }));
    expect(r.costSource).toBe('CMC_MARGEM_ATIPICA');
    expect(r.costFinal).toBe(100);
  });

  it('margem baixa POSITIVA abaixo de margemMin (cmc=97, ~3%) → atípica (não mais proxy)', () => {
    const r = computeCostLadder(input({ cmc: 97 }));
    expect(r.costSource).toBe('CMC_MARGEM_ATIPICA');
    expect(r.costPriceToPersist).toBe(97);
  });

  it('margem ALTA acima de margemMax (cmc=10, 90%) → atípica (corrige o masking do lado alto)', () => {
    const r = computeCostLadder(input({ cmc: 10 }));
    expect(r.costSource).toBe('CMC_MARGEM_ATIPICA');
    expect(r.costPriceToPersist).toBe(10);
  });

  it('bordas EXATAS da banda (cmc==price*0.95 e ==price*0.15) caem em atípica (banda é aberta)', () => {
    expect(computeCostLadder(input({ cmc: 95 })).costSource).toBe('CMC_MARGEM_ATIPICA');
    expect(computeCostLadder(input({ cmc: 15 })).costSource).toBe('CMC_MARGEM_ATIPICA');
  });

  it('CMC atípico vence o proxy de família (não degrada custo real a proxy)', () => {
    const r = computeCostLadder(input({ cmc: 120, familyTargetMargin: 0.4 }));
    expect(r.costSource).toBe('CMC_MARGEM_ATIPICA');
    expect(r.costPriceToPersist).toBe(120);
  });

  it('invariante: todo CMC atípico SEMEIA cost_price === cmc (real CMC-derivado carrega cost_price)', () => {
    for (const cmc of [120, 100, 97, 10, 95, 15, 1, 500]) {
      const r = computeCostLadder(input({ cmc }));
      expect(r.costSource).toBe('CMC_MARGEM_ATIPICA');
      expect(r.costPriceToPersist).toBe(cmc);
      expect(r.costFinal).toBe(cmc);
    }
  });
});

// O anti-lixo é a ÚNICA proteção que sobra (não mais a banda de margem): rejeita CMC que só
// pode ser erro de dado (custo quase-zero ou desproporcional ao preço). Fora dele → proxy honesto.
describe('computeCostLadder — guard anti-lixo absoluto (erro de dado degrada a proxy, NUNCA semeia)', () => {
  it('cmc absurdamente alto (ratio > cmcRatioMax) → proxy, cost_price NÃO semeado', () => {
    const r = computeCostLadder(input({ cmc: 600, familyTargetMargin: 0.4 })); // 6× o preço
    expect(r.costSource).toBe('FAMILY_MARGIN_PROXY');
    expect(r.costPriceToPersist).toBeNull();
  });

  it('cmc quase-zero (ratio < cmcRatioMin) → proxy, cost_price NÃO semeado', () => {
    const r = computeCostLadder(input({ cmc: 0.5, familyTargetMargin: 0.4 })); // 0.5% do preço
    expect(r.costSource).toBe('FAMILY_MARGIN_PROXY');
    expect(r.costPriceToPersist).toBeNull();
  });

  it('cmc absurdo sem família → DEFAULT_PROXY (degradação honesta, não fabrica custo)', () => {
    const r = computeCostLadder(input({ cmc: 600 }));
    expect(r.costSource).toBe('DEFAULT_PROXY');
    expect(r.costPriceToPersist).toBeNull();
  });

  it('bordas do anti-lixo são INCLUSIVAS (cmc==price*kMax e ==price*kMin ainda são CMC real)', () => {
    expect(computeCostLadder(input({ cmc: 500 })).costSource).toBe('CMC_MARGEM_ATIPICA'); // ==price*5
    expect(computeCostLadder(input({ cmc: 1 })).costSource).toBe('CMC_MARGEM_ATIPICA');   // ==price*0.01
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

describe('computeCostLadder — anti-lavagem (o bug do #977 que continua morto)', () => {
  it('NUNCA emite PRODUCT_COST a partir desta escada (não há writer real hoje)', () => {
    const inputs: CostLadderInput[] = [
      input({ cmc: 60 }),
      input({ cmc: 120 }), // agora atípica, mas ainda nunca PRODUCT_COST
      input({ cmc: null, familyTargetMargin: 0.4 }),
      input({ cmc: null, familyTargetMargin: null }),
      input({ cmc: 0, familyTargetMargin: 0.4 }),
    ];
    for (const i of inputs) {
      expect(computeCostLadder(i).costSource).not.toBe('PRODUCT_COST');
    }
  });

  it('idempotência entre runs: SKU sem CMC continua proxy em toda run (não há promoção a real)', () => {
    const i = input({ cmc: null, familyTargetMargin: 0.4 });
    const run1 = computeCostLadder(i);
    const run2 = computeCostLadder(i);
    expect(run2).toEqual(run1);
    expect(run2.costSource).toBe('FAMILY_MARGIN_PROXY');
    expect(run2.costPriceToPersist).toBeNull();
  });

  it('todo resultado PROXY tem costPriceToPersist === null (invariante global)', () => {
    for (let m = 0.06; m < 0.85; m += 0.07) {
      const r = computeCostLadder(input({ cmc: null, familyTargetMargin: m }));
      if (r.costSource !== 'CMC' && r.costSource !== 'CMC_MARGEM_ATIPICA') {
        expect(r.costPriceToPersist).toBeNull();
      }
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
