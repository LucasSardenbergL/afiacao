import { describe, it, expect } from 'vitest';
import { calcularAuditoriaMargemCliente, type AuditOrderLine } from '../auditoria-margem';
import type { CostRow } from '../cost-source';

const realRow = (cf: number): CostRow => ({ cost_price: null, cost_final: cf, cost_source: 'PRODUCT_COST', cost_confidence: 0.95 });
const proxyRow = (cf: number): CostRow => ({ cost_price: null, cost_final: cf, cost_source: 'DEFAULT_PROXY', cost_confidence: 0.25 });

// A: actual 80, best 100, qty 2 → leak (100-80)*2 = 40 ; B: actual 50, best 50, qty 1 → leak 0
const orders: AuditOrderLine[] = [
  { product_id: 'A', unit_price: 80, desconto_valor: 0, quantity: 2 },
  { product_id: 'B', unit_price: 50, desconto_valor: 0, quantity: 1 },
];
const best = (id: string): number | null => (({ A: 100, B: 50 }) as Record<string, number>)[id] ?? null;

describe('calcularAuditoriaMargemCliente — cost-invariância do gap (falsificação)', () => {
  it('margin_gap, top_gap e gap_pct NÃO dependem do custo (cancela); níveis absolutos SIM', () => {
    const c10 = calcularAuditoriaMargemCliente({ orders, custoPorProduto: () => realRow(10), bestPrice: best });
    const c40 = calcularAuditoriaMargemCliente({ orders, custoPorProduto: () => realRow(40), bestPrice: best });
    // cost-invariante:
    expect(c10.margin_gap).toBe(40);
    expect(c40.margin_gap).toBe(40);
    expect(c10.gap_pct).toBe(16);   // 40 / (100*2 + 50*1) * 100
    expect(c40.gap_pct).toBe(16);
    expect(c10.top_gap_products).toEqual([{ product_id: 'A', gap: 40 }]);
    expect(c40.top_gap_products).toEqual([{ product_id: 'A', gap: 40 }]);
    // cost-dependente (níveis absolutos mudam):
    expect(c10.margin_real).toBe(180);      // (80-10)*2 + (50-10)*1
    expect(c40.margin_real).toBe(90);       // (80-40)*2 + (50-40)*1
    expect(c10.margin_potential).toBe(220); // (100-10)*2 + (50-10)*1
  });
});

describe('calcularAuditoriaMargemCliente — gate de cobertura', () => {
  it('cobertura <85% (maioria proxy) → margin_real/potential null, mas gap/gap_pct seguem', () => {
    const mixed: AuditOrderLine[] = [
      { product_id: 'A', unit_price: 80, desconto_valor: 0, quantity: 1 },  // real
      { product_id: 'P', unit_price: 90, desconto_valor: 0, quantity: 1 },  // proxy → sem custo confiável
    ];
    const cost = (id: string): CostRow => id === 'A' ? realRow(10) : proxyRow(45);
    const bestM = (id: string): number | null => (({ A: 100, P: 100 }) as Record<string, number>)[id] ?? null;
    const r = calcularAuditoriaMargemCliente({ orders: mixed, custoPorProduto: cost, bestPrice: bestM });
    expect(r.margin_real).toBeNull();
    expect(r.margin_potential).toBeNull();
    expect(r.margin_gap).toBe(30);               // leak A (100-80)*1=20 + P (100-90)*1=10
    expect(r.gap_pct).toBe(15);                  // 30 / (100+100) * 100
    expect(r.cobertura_custo).toBeCloseTo(80 / 170, 5); // receitaComCusto 80 / receita 170
  });

  it('cobertura ≥85% → níveis presentes', () => {
    const r = calcularAuditoriaMargemCliente({ orders, custoPorProduto: () => realRow(10), bestPrice: best });
    expect(r.cobertura_custo).toBe(1);
    expect(r.margin_real).toBe(180);
  });
});

describe('calcularAuditoriaMargemCliente — degenerados', () => {
  it('sem linha válida (product_id null) → gap 0, gap_pct null, margins null', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: null, unit_price: 1, desconto_valor: 0, quantity: 1 }],
      custoPorProduto: () => null,
      bestPrice: () => null,
    });
    expect(r.margin_gap).toBe(0);
    expect(r.gap_pct).toBeNull();
    expect(r.margin_real).toBeNull();
  });
  it('sem best price → bestPrice = actualPrice → leak 0', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: 'X', unit_price: 70, desconto_valor: 0, quantity: 1 }],
      custoPorProduto: () => realRow(20),
      bestPrice: () => null,
    });
    expect(r.margin_gap).toBe(0);
    expect(r.gap_pct).toBe(0);
    expect(r.margin_real).toBe(50); // (70-20)*1
  });
});

describe('calcularAuditoriaMargemCliente — robustez de qualidade-de-dado (Codex challenge)', () => {
  const bestOf = (m: Record<string, number | null>) => (id: string): number | null => m[id] ?? null;
  it('bestPrice ≤ 0 (dado ruim) → fallback actualPrice → leak 0 (não poisona gap)', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: 'A', unit_price: 80, desconto_valor: 0, quantity: 1 }],
      custoPorProduto: () => realRow(10),
      bestPrice: bestOf({ A: 0 }), // best price zerado/inválido — NÃO virar (0-80)*1 = -80
    });
    expect(r.margin_gap).toBe(0);
    expect(r.gap_pct).toBe(0);
    expect(r.margin_real).toBe(70);
  });
  it('bestPrice negativo → fallback actualPrice → leak 0', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: 'A', unit_price: 80, desconto_valor: 0, quantity: 1 }],
      custoPorProduto: () => realRow(10),
      bestPrice: bestOf({ A: -5 }),
    });
    expect(r.margin_gap).toBe(0);
  });
  it('devolução (qty negativa) é ignorada — não distorce gap nem cobertura', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [
        { product_id: 'A', unit_price: 80, desconto_valor: 0, quantity: 2 },  // venda: leak (100-80)*2=40
        { product_id: 'A', unit_price: 80, desconto_valor: 0, quantity: -1 }, // devolução: ignorada
      ],
      custoPorProduto: () => realRow(10),
      bestPrice: bestOf({ A: 100 }),
    });
    expect(r.margin_gap).toBe(40);
    expect(r.cobertura_custo).toBe(1);
  });
  it('item GRÁTIS (desconto_valor = linha inteira → actualPrice 0, qty>0) CONTA — é o maior leakage (Codex #7)', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [
        { product_id: 'A', unit_price: 100, desconto_valor: 0, quantity: 1 },   // venda normal: leak 0
        { product_id: 'B', unit_price: 100, desconto_valor: 100, quantity: 1 }, // GRÁTIS: actualPrice 0, leak (100-0)*1=100
      ],
      custoPorProduto: () => realRow(30),
      bestPrice: bestOf({ A: 100, B: 100 }),
    });
    expect(r.margin_gap).toBe(100);                             // o grátis NÃO some (seria 0 se dropado)
    expect(r.top_gap_products).toEqual([{ product_id: 'B', gap: 100 }]);
    expect(r.cobertura_custo).toBe(1);                          // receita 100 estável, ambas com custo
  });
  it('desconto_valor > qty×preço (actualPrice negativo) é ignorado; cobertura fica em [0,1]', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [
        { product_id: 'A', unit_price: 100, desconto_valor: 0, quantity: 1 },   // válida, com custo
        { product_id: 'B', unit_price: 100, desconto_valor: 150, quantity: 1 }, // actualPrice -50 → ignorada
      ],
      custoPorProduto: (id) => id === 'A' ? realRow(40) : null,
      bestPrice: bestOf({ A: 120, B: 120 }),
    });
    expect(r.cobertura_custo).toBe(1);          // só a linha A válida, e tem custo
    expect(r.cobertura_custo).toBeLessThanOrEqual(1);
    expect(r.margin_real).toBe(60);             // (100-40)*1
  });
});

describe('calcularAuditoriaMargemCliente — desconto_valor é R$ da LINHA, e desconhecido ≠ 0', () => {
  const bestOf = (m: Record<string, number | null>) => (id: string): number | null => m[id] ?? null;

  it('desconto da linha se dilui pela quantidade: up − desconto/qty (não percentual, não por unidade)', () => {
    // up 100, qty 2, R$ 10 na linha → líquido 95/un → leak (100-95)*2 = 10.
    // Percentual antigo daria 90/un (leak 20); subtrair por unidade daria 90/un também — os dois erros.
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: 'A', unit_price: 100, desconto_valor: 10, quantity: 2 }],
      custoPorProduto: () => realRow(60),
      bestPrice: bestOf({ A: 100 }),
    });
    expect(r.margin_gap).toBe(10);
    expect(r.margin_real).toBe(70);              // (95-60)*2
    expect(r.linhas_desconto_desconhecido).toBe(0);
  });

  it('desconto NULL (não apurado) NÃO vira 0: a linha sai das somas e é CONTADA', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [
        { product_id: 'A', unit_price: 80, desconto_valor: 0, quantity: 1 },     // conhecida: leak 20
        { product_id: 'B', unit_price: 50, desconto_valor: null, quantity: 3 },  // desconhecida
      ],
      custoPorProduto: () => realRow(10),
      bestPrice: bestOf({ A: 100, B: 100 }),
    });
    // Se o null virasse 0, B somaria leak (100-50)*3 = 150 e o gap seria 170.
    expect(r.margin_gap).toBe(20);
    expect(r.gap_pct).toBe(20);                  // 20 / 100 — o bestRevenue de B também não entra
    expect(r.margin_real).toBe(70);
    expect(r.linhas_desconto_desconhecido).toBe(1);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negativo', -5],
  ])('desconto %s é desconhecido (fora das somas, contado)', (_rotulo, d) => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: 'A', unit_price: 80, desconto_valor: d, quantity: 1 }],
      custoPorProduto: () => realRow(10),
      bestPrice: bestOf({ A: 100 }),
    });
    expect(r.margin_gap).toBe(0);
    expect(r.gap_pct).toBeNull();
    expect(r.linhas_desconto_desconhecido).toBe(1);
  });

  it('desconto undefined (coluna fora do select) também é desconhecido, nunca 0', () => {
    const linha = { product_id: 'A', unit_price: 80, quantity: 1 } as unknown as AuditOrderLine;
    const r = calcularAuditoriaMargemCliente({ orders: [linha], custoPorProduto: () => realRow(10), bestPrice: bestOf({ A: 100 }) });
    expect(r.margin_gap).toBe(0);
    expect(r.linhas_desconto_desconhecido).toBe(1);
  });

  it('guard dimensional: desconto = linha inteira (qty 2) é GRÁTIS e fica; 1 centavo acima sai sem contar como desconhecido', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [
        { product_id: 'A', unit_price: 50, desconto_valor: 100, quantity: 2 },     // grátis: leak 100*2
        { product_id: 'B', unit_price: 50, desconto_valor: 100.01, quantity: 2 },  // > bruto → lixo
      ],
      custoPorProduto: () => realRow(10),
      bestPrice: bestOf({ A: 100, B: 100 }),
    });
    expect(r.margin_gap).toBe(200);
    expect(r.top_gap_products).toEqual([{ product_id: 'A', gap: 200 }]);
    expect(r.linhas_desconto_desconhecido).toBe(0);
  });

  it('devolução com desconto NULL não conta como desconhecido (não é venda)', () => {
    const r = calcularAuditoriaMargemCliente({
      orders: [{ product_id: 'A', unit_price: 80, desconto_valor: null, quantity: -1 }],
      custoPorProduto: () => realRow(10),
      bestPrice: bestOf({ A: 100 }),
    });
    expect(r.linhas_desconto_desconhecido).toBe(0);
  });
});
