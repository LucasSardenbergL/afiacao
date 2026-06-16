import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Wallet } from 'lucide-react';
import { KpiCard } from '../KpiCard';

describe('KpiCard', () => {
  it('renderiza título e valor compacto', () => {
    render(
      <KpiCard
        title="A Receber"
        value={1_500_000}
        icon={Wallet}
        color="text-status-success"
        bgColor="bg-status-success-bg"
      />,
    );
    expect(screen.getByText('A Receber')).toBeTruthy();
    expect(screen.getByText('R$ 1.5M')).toBeTruthy();
  });

  it('mostra subtitle quando fornecido', () => {
    render(
      <KpiCard
        title="A Pagar"
        value={0}
        icon={Wallet}
        color=""
        bgColor=""
        subtitle="R$ 100,00 vencido"
      />,
    );
    expect(screen.getByText('R$ 100,00 vencido')).toBeTruthy();
  });

  it('sem subtitle não renderiza linha extra', () => {
    render(<KpiCard title="X" value={0} icon={Wallet} color="" bgColor="" />);
    expect(screen.queryByText(/vencido/)).toBeNull();
  });
});
