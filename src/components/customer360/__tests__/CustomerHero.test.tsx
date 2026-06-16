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

const score = { health_class: 'saudavel', churn_risk: 10, gross_margin_pct: 0.35 } as unknown as CustomerScore;

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
