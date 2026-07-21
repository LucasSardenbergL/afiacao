import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CustomerHero } from '../CustomerHero';
import type { Customer, CustomerScore } from '../viewTypes';

// AgendarVisitaDialog (renderizado pelo CustomerHero) usa useVisitasAgendadas →
// useAuth/useQueryClient. Mockamos o hook: este é um teste unitário do hero, não do dialog.
vi.mock('@/hooks/useVisitasAgendadas', () => ({
  useVisitasAgendadas: () => ({
    agendar: { mutate: vi.fn(), isPending: false },
  }),
}));

const customer = {
  name: 'Acme Ltda',
  document: '12345678000190',
  user_id: 'u1',
  created_at: '2026-01-01',
  avatar_url: null,
  requires_po: false,
  phone: null,
  email: null,
  customer_type: null,
  cnae: null,
} as unknown as Customer;

const score = { health_class: 'saudavel', churn_risk: 10, gross_margin_pct: 35 } as unknown as CustomerScore;

function renderHero(ui: React.ReactElement) {
  return render(<MemoryRouter><TooltipProvider>{ui}</TooltipProvider></MemoryRouter>);
}

describe('CustomerHero', () => {
  it('renderiza nome, badge PJ e CTA novo pedido; voltar dispara onBack', () => {
    const onBack = vi.fn();
    renderHero(<CustomerHero customer={customer} score={score} isPj onBack={onBack} />);
    expect(screen.getByText('Acme Ltda')).toBeTruthy();
    expect(screen.getByText('PJ')).toBeTruthy();
    expect(screen.getByText(/Novo pedido/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Clientes/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('PF (isPj=false) → badge PF', () => {
    renderHero(<CustomerHero customer={{ ...customer, document: '12345678901' }} score={null} isPj={false} onBack={() => {}} />);
    expect(screen.getByText('PF')).toBeTruthy();
  });
});

// ── Margem no hero: unidade e ausência (money-path) ────────────────────────────
// Estes casos provam o guard NO CONSUMIDOR. Testar só o helper não prova que o
// componente parou de coagir — a coação a montante é que decide (money-path §2).
describe('CustomerHero — badge de margem', () => {
  const comMargem = (m: number | null) =>
    ({ health_class: 'saudavel', churn_risk: 10, gross_margin_pct: m }) as unknown as CustomerScore;

  it('margem desconhecida NÃO renderiza o badge (nem como 0%)', () => {
    renderHero(<CustomerHero customer={customer} score={comMargem(null)} isPj onBack={vi.fn()} />);
    expect(screen.queryByText(/margem/)).toBeNull();
  });

  it('exibe percentual sem reescalar — 56 é "56%", não "5600%"', () => {
    renderHero(<CustomerHero customer={customer} score={comMargem(56)} isPj onBack={vi.fn()} />);
    expect(screen.getByText(/56% margem/)).toBeTruthy();
  });

  it('margem negativa não vira -6000% (a heurística antiga multiplicava por 100)', () => {
    renderHero(<CustomerHero customer={customer} score={comMargem(-60)} isPj onBack={vi.fn()} />);
    expect(screen.getByText(/-60% margem/)).toBeTruthy();
  });

  it('margem de 5% é pintada como BAIXA, não como alta por passar de 0.3', () => {
    const { container } = renderHero(
      <CustomerHero customer={customer} score={comMargem(5)} isPj onBack={vi.fn()} />,
    );
    const badge = Array.from(container.querySelectorAll('span')).find((e) =>
      e.textContent?.includes('margem'),
    );
    expect(badge?.className).toContain('status-error');
    expect(badge?.className).not.toContain('status-success');
  });

  it('margem de 56% é pintada como ALTA', () => {
    const { container } = renderHero(
      <CustomerHero customer={customer} score={comMargem(56)} isPj onBack={vi.fn()} />,
    );
    const badge = Array.from(container.querySelectorAll('span')).find((e) =>
      e.textContent?.includes('margem'),
    );
    expect(badge?.className).toContain('status-success');
  });

  it('margem de 20% cai na faixa intermediária', () => {
    const { container } = renderHero(
      <CustomerHero customer={customer} score={comMargem(20)} isPj onBack={vi.fn()} />,
    );
    const badge = Array.from(container.querySelectorAll('span')).find((e) =>
      e.textContent?.includes('margem'),
    );
    expect(badge?.className).toContain('status-warning');
  });
});
