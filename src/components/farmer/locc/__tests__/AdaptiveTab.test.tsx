import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdaptiveTab } from '../AdaptiveTab';
import type { AlgorithmConfig } from '@/hooks/useFarmerScoring';
import type { FarmerMetrics } from '@/hooks/useFarmerMetrics';

const config = {
  health_w_rf: 0.35, health_w_m: 0.2, health_w_g: 0.2, health_w_x: 0.15, health_w_s: 0.15,
  priority_w_churn: 0.4, priority_w_recover: 0.3, priority_w_expansion: 0.2, priority_w_eff: 0.1,
  agenda_pct_risco: 0.5, agenda_pct_expansao: 0.3, agenda_pct_followup: 0.2,
} as unknown as AlgorithmConfig;

const metrics = {
  portfolioRecommendation: 'expand',
  currentActiveClients: 40,
  optimalClientsCount: 50,
  optimalFrequencyPerMonth: 2.5,
  daysOfData: 30,
  totalCalls: 100,
  weights: { suggested_calls_per_day: 8, suggested_portfolio_size: 55 },
} as unknown as FarmerMetrics;

describe('AdaptiveTab', () => {
  it('renderiza os pesos do health score com percentuais', () => {
    render(<AdaptiveTab config={config} metrics={metrics} navigate={vi.fn()} />);
    expect(screen.getByText('RF (Recência)')).toBeTruthy();
    expect(screen.getByText('35%')).toBeTruthy(); // 0.35 * 100 (único)
  });

  it('mostra a recomendação de carteira e a frequência ótima', () => {
    render(<AdaptiveTab config={config} metrics={metrics} navigate={vi.fn()} />);
    expect(screen.getByText('📈 Expandir')).toBeTruthy();
    expect(screen.getByText('2.5x/mês')).toBeTruthy();
  });

  it('navega para governança ao clicar no botão', () => {
    const navigate = vi.fn();
    render(<AdaptiveTab config={config} metrics={metrics} navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Propor Alteração de Pesos/ }));
    expect(navigate).toHaveBeenCalledWith('/farmer/governance');
  });
});
