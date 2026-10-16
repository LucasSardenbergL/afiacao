import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CustomerHero } from '../CustomerHero';
import { margemTone, MARGEM_BOA_MIN, MARGEM_ATENCAO_MIN } from '../format';
import type { Customer, CustomerScore } from '../viewTypes';

vi.mock('@/hooks/useVisitasAgendadas', () => ({
  useVisitasAgendadas: () => ({ agendar: { mutate: vi.fn(), isPending: false } }),
}));

const customer = {
  name: 'Acme Ltda', document: '12345678000190', user_id: 'u1', created_at: '2026-01-01',
  avatar_url: null, requires_po: false, phone: null, email: null, customer_type: null, cnae: null,
} as unknown as Customer;

/**
 * Cortes escolhidos pelo founder em 2026-10-16 sobre a distribuição real (501 clientes c/ margem,
 * p10 32,6 · p50 58,0): verde ≥ 55 (≈ mediana), vermelho < 30 (≈ os 7% piores + negativas).
 * Os 30/15 antigos pintavam 93% de verde — o badge não discriminava.
 */
describe('margemTone — cortes 55 / 30', () => {
  it('fixa os cortes escolhidos (mudar exige nova decisão de produto)', () => {
    expect(MARGEM_BOA_MIN).toBe(55);
    expect(MARGEM_ATENCAO_MIN).toBe(30);
  });

  it.each([
    [99.7, 'boa'],
    [55, 'boa'], // fronteira inclusiva
    [54.99, 'atencao'],
    [42, 'atencao'],
    [30, 'atencao'], // fronteira inclusiva
    [29.99, 'baixa'],
    [0, 'baixa'], // 0 é margem CONHECIDA e ruim, não ausência
    [-5.8, 'baixa'], // margem negativa real em prod
  ] as const)('%s%% → %s', (pct, faixa) => {
    expect(margemTone(pct).faixa).toBe(faixa);
  });

  it('a margem de 31% (verde nos cortes antigos) agora é atenção', () => {
    expect(margemTone(31).faixa).toBe('atencao');
  });
});

describe('CustomerHero — o badge discrimina as três faixas', () => {
  const renderComMargem = (pct: number | null) =>
    render(
      <MemoryRouter><TooltipProvider>
        <CustomerHero
          customer={customer}
          score={{ health_class: 'saudavel', churn_risk: 10, gross_margin_pct: pct } as unknown as CustomerScore}
          isPj
          onBack={() => {}}
        />
      </TooltipProvider></MemoryRouter>,
    );
  const badge = () => screen.getByText(/margem$/).closest('span') as HTMLElement;

  it.each([
    [55, 'status-success'],
    [54.99, 'status-warning'],
    [30, 'status-warning'],
    [29.99, 'status-error'],
    [-5.8, 'status-error'],
  ])('%s%% pinta %s', (pct, token) => {
    renderComMargem(pct);
    expect(badge().className).toContain(`bg-${token}-bg`);
  });

  it('margem ausente (null) não vira faixa — sem badge colorido', () => {
    renderComMargem(null);
    expect(screen.queryByText(/margem$/)).toBeNull();
  });
});
