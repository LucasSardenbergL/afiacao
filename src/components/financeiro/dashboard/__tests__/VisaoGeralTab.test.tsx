import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { VisaoGeralTab } from '../VisaoGeralTab';
import type { FinResumo, AgingData } from '@/services/financeiroService';
import type { FinAlert } from '@/utils/financeiroAlerts';

// VisaoGeralTab usa <DataHealthBanner> (react-query) → precisa de QueryClientProvider.
const renderWithClient = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const resumoCo: FinResumo = {
  contas_correntes: [{ descricao: 'Conta BB', saldo_atual: 5000, banco: 'Banco do Brasil' }],
  saldo_total_cc: 5000,
  total_a_receber: 10000,
  total_a_pagar: 4000,
  total_vencido_receber: 1500,
  total_vencido_pagar: 500,
  posicao_liquida: 6000,
};

const aging: AgingData = {
  a_vencer_qtd: 1, a_vencer_valor: 1000,
  vencido_1_30_qtd: 0, vencido_1_30_valor: 0,
  vencido_31_60_qtd: 0, vencido_31_60_valor: 0,
  vencido_61_90_qtd: 0, vencido_61_90_valor: 0,
  vencido_90_plus_qtd: 2, vencido_90_plus_valor: 800,
};

const inadimplentes = [{ nome: 'Cliente XPTO', cnpj: '12345678000190', total_vencido: 800, qtd_titulos: 2 }];

describe('VisaoGeralTab', () => {
  it('renderiza os 4 KPIs sempre, sem cards de consolidado quando view != all', () => {
    renderWithClient(
      <VisaoGeralTab
        alerts={[]}
        activeResumo={null}
        resumo={{}}
        view="oben"
        agingReceber={null}
        agingPagar={null}
        inadimplentes={[]}
      />
    );
    expect(screen.getByText('A Receber')).toBeTruthy();
    expect(screen.getByText('A Pagar')).toBeTruthy();
    expect(screen.getByText('Posição Líquida')).toBeTruthy();
    expect(screen.getByText('Saldo Bancário')).toBeTruthy();
    expect(screen.queryByText('Posição por Empresa')).toBeNull();
    expect(screen.queryByText('Regime Tributário')).toBeNull();
  });

  it('view=all com dados → cards de empresa, indicadores, regime, inadimplentes e contas correntes', () => {
    renderWithClient(
      <VisaoGeralTab
        alerts={[]}
        activeResumo={resumoCo}
        resumo={{ colacor: resumoCo }}
        view="all"
        agingReceber={aging}
        agingPagar={aging}
        inadimplentes={inadimplentes}
      />
    );
    expect(screen.getByText('Posição por Empresa')).toBeTruthy();
    expect(screen.getByText('Indicadores Financeiros')).toBeTruthy();
    expect(screen.getByText('Regime Tributário')).toBeTruthy();
    expect(screen.getByText('Maiores Inadimplentes')).toBeTruthy();
    expect(screen.getByText('Cliente XPTO')).toBeTruthy();
    expect(screen.getByText('Contas Correntes')).toBeTruthy();
    expect(screen.getByText('Conta BB')).toBeTruthy();
  });

  it('renderiza mensagens de alerta', () => {
    const alerts: FinAlert[] = [
      { severity: 'critical', company: 'colacor', message: 'Alerta teste', metric: 'metric x', icon: AlertTriangle },
    ];
    renderWithClient(
      <VisaoGeralTab
        alerts={alerts}
        activeResumo={null}
        resumo={{}}
        view="oben"
        agingReceber={null}
        agingPagar={null}
        inadimplentes={[]}
      />
    );
    expect(screen.getByText('Alerta teste')).toBeTruthy();
    expect(screen.getByText('metric x')).toBeTruthy();
  });
});
