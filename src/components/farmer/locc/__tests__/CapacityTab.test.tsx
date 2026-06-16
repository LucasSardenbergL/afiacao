import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapacityTab } from '../CapacityTab';
import type { FarmerMetrics } from '@/hooks/useFarmerMetrics';

const metrics = {
  avgCallDuration: 90,
  avgFollowUpDuration: 30,
  avgAttemptsToContact: 2.3,
  tTotal: 0.5,
  capacityPerDay: 12.4,
  optimalClientsCount: 50,
  totalCalls: 100,
  totalMargin: 5000,
  marginPerHour: 250,
  contactRate: 65.2,
  daysOfData: 10,
  conversionByType: { reativacao: 10, cross_sell: 20, up_sell: 5, follow_up: 15 },
  hasEnoughData: false,
} as unknown as FarmerMetrics;

describe('CapacityTab', () => {
  it('renderiza métricas de capacidade e conversão', () => {
    render(<CapacityTab metrics={metrics} />);
    expect(screen.getByText('Motor de Capacidade')).toBeTruthy();
    expect(screen.getByText('12 ligações')).toBeTruthy(); // Math.round(12.4)
    expect(screen.getByText('Reativação')).toBeTruthy();
    expect(screen.getByText('20.0%')).toBeTruthy(); // cross_sell
  });

  it('mostra o aviso de 30 dias quando não há dados suficientes', () => {
    render(<CapacityTab metrics={metrics} />);
    expect(screen.getByText(/Progresso: 10\/30 dias/)).toBeTruthy();
  });

  it('esconde o aviso quando hasEnoughData', () => {
    render(<CapacityTab metrics={{ ...metrics, hasEnoughData: true } as unknown as FarmerMetrics} />);
    expect(screen.queryByText(/Progresso:/)).toBeNull();
  });
});
