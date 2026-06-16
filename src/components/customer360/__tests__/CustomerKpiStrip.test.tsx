import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomerKpiStrip } from '../CustomerKpiStrip';
import type { CustomerMetrics, CustomerScore, RevenueDerived } from '../viewTypes';

const revenueDerived: RevenueDerived = { lifetime: 20000, last12: 12000, orderCount12m: 8, lastOrderAt: '2026-01-01' };
const metrics = {
  faturamento_90d: 5000, faturamento_prev_90d: 4000, pedidos_90d: 3,
  ticket_medio_90d: 1600, dias_desde_ultima_compra: 5, intervalo_medio_dias: 30,
} as unknown as CustomerMetrics;
const score = { avg_repurchase_interval: 30 } as unknown as CustomerScore;

describe('CustomerKpiStrip', () => {
  it('renderiza os 4 KPIs com valores derivados', () => {
    render(<CustomerKpiStrip revenueDerived={revenueDerived} metrics={metrics} score={score} />);
    expect(screen.getByText('Faturamento 12m')).toBeTruthy();
    expect(screen.getByText('Faturamento 90d')).toBeTruthy();
    expect(screen.getByText('Ticket médio (90d)')).toBeTruthy();
    expect(screen.getByText('Última compra')).toBeTruthy();
    expect(screen.getByText('8 pedidos')).toBeTruthy();
    expect(screen.getByText('5d')).toBeTruthy();
  });
});
