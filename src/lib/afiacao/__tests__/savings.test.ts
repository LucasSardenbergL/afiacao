import { describe, it, expect } from 'vitest';
import { computeSavings, AVG_NEW_TOOL_COST, type SavingsOrderInput } from '../savings';

// Relógio fixo → janela de 6 meses determinística (jun/2026 volta a fev/2026).
const NOW = new Date('2026-07-15T12:00:00Z');

describe('computeSavings', () => {
  it('sem pedidos → tudo zero, sem fabricar economia', () => {
    const r = computeSavings([], NOW);
    expect(r.totalTools).toBe(0);
    expect(r.totalSpent).toBe(0);
    expect(r.totalSavings).toBe(0);
    // ausência ≠ economia: 0% honesto, não um número inventado
    expect(r.savingsPercent).toBe(0);
    expect(r.monthlyData).toHaveLength(6);
    expect(r.monthlyData.every((m) => m.toolCount === 0 && m.savings === 0)).toBe(true);
  });

  it('soma quantidades e calcula economia vs. comprar novo', () => {
    const orders: SavingsOrderInput[] = [
      { created_at: '2026-07-10T00:00:00Z', total: 100, items: [{ quantity: 2 }] },
      { created_at: '2026-06-05T00:00:00Z', total: 50, items: [{ quantity: 1 }] },
    ];
    const r = computeSavings(orders, NOW);
    expect(r.totalTools).toBe(3); // 2 + 1
    expect(r.totalSpent).toBe(150); // 100 + 50
    // 3 × 250 − 150 = 600
    expect(r.totalSavings).toBe(3 * AVG_NEW_TOOL_COST - 150);
    expect(r.totalSavings).toBe(600);
    expect(r.savingsPercent).toBe(80); // round(600 / 750 × 100)
  });

  it('item sem quantity conta como 1; items não-array conta como 0', () => {
    const orders: SavingsOrderInput[] = [
      { created_at: '2026-07-01T00:00:00Z', total: 30, items: [{}] }, // → 1
      { created_at: '2026-07-02T00:00:00Z', total: 0, items: null }, // → 0
    ];
    const r = computeSavings(orders, NOW);
    expect(r.totalTools).toBe(1);
  });

  it('a série mensal tem 6 meses e o último é o mês de `now`', () => {
    const r = computeSavings(
      [{ created_at: '2026-07-10T00:00:00Z', total: 100, items: [{ quantity: 2 }] }],
      NOW,
    );
    expect(r.monthlyData).toHaveLength(6);
    const julho = r.monthlyData[5];
    expect(julho.toolCount).toBe(2);
    expect(julho.sharpeningCost).toBe(100);
    expect(julho.newToolCost).toBe(500); // 2 × 250
    expect(julho.savings).toBe(400); // 500 − 100
  });

  it('savings mensal nunca é negativo (piso em 0), mesmo gastando mais que o custo-novo', () => {
    // 1 ferramenta, R$1000 gastos → comprar novo custaria só R$250
    const r = computeSavings(
      [{ created_at: '2026-07-10T00:00:00Z', total: 1000, items: [{ quantity: 1 }] }],
      NOW,
    );
    expect(r.monthlyData[5].savings).toBe(0); // piso
    // total cru PODE ser negativo — o consumidor decide como exibir
    expect(r.totalSavings).toBe(250 - 1000);
    expect(r.totalSavings).toBeLessThan(0);
  });

  it('pedidos fora da janela de 6 meses ainda contam no total, mas não na série', () => {
    const orders: SavingsOrderInput[] = [
      { created_at: '2025-01-01T00:00:00Z', total: 80, items: [{ quantity: 1 }] }, // antigo
    ];
    const r = computeSavings(orders, NOW);
    expect(r.totalTools).toBe(1);
    expect(r.totalSpent).toBe(80);
    // nenhum dos 6 meses recentes recebeu esse pedido
    expect(r.monthlyData.every((m) => m.toolCount === 0)).toBe(true);
  });
});
