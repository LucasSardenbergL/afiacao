import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomerKpiStrip } from '../CustomerKpiStrip';
import type { CustomerMetrics, CustomerScore, RevenueDerived } from '../viewTypes';

const revenueDerived: RevenueDerived = {
  last12: 12000,
  orderCount12m: 8,
  faturamentoIndisponivel: false,
  metricasIndisponiveis: false,
};
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

  it('faturamento 12m que FALHOU mostra "indisponível", não R$ 0 e 0 pedidos', () => {
    render(
      <CustomerKpiStrip
        revenueDerived={{ ...revenueDerived, last12: null, orderCount12m: null, faturamentoIndisponivel: true }}
        metrics={metrics}
        score={score}
      />,
    );
    expect(screen.getByText('indisponível')).toBeTruthy();
    expect(screen.queryByText('0 pedidos')).toBeNull();
  });

  it('MV que falhou: 90d, ticket e última compra viram "—", nunca R$ 0 nem "Nunca"', () => {
    render(
      <CustomerKpiStrip
        revenueDerived={{ ...revenueDerived, metricasIndisponiveis: true }}
        metrics={undefined as unknown as CustomerMetrics}
        score={score}
      />,
    );
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText('Nunca')).toBeNull();
  });

  it('o sentinela 9999 da MV ("nunca comprou") aparece como "Nunca", não "9999d"', () => {
    render(
      <CustomerKpiStrip
        revenueDerived={revenueDerived}
        metrics={{ ...metrics, dias_desde_ultima_compra: 9999, intervalo_medio_dias: null } as unknown as CustomerMetrics}
        score={score}
      />,
    );
    expect(screen.getByText('Nunca')).toBeTruthy();
    expect(screen.queryByText('9999d')).toBeNull();
  });
});
