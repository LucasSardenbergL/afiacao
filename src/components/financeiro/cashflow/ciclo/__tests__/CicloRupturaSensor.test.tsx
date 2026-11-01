import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { SemanaPedidos, SemanaPrateleira } from '@/lib/financeiro/ruptura-sensor-helpers';

const sensorMock = vi.fn();
vi.mock('@/hooks/useFinanceiroCiclo', () => ({ useRupturaSensor: () => sensorMock() }));

import { CicloRupturaSensor } from '@/components/financeiro/cashflow/ciclo/CicloRupturaSensor';

const sem = (semana: string, o: Partial<SemanaPedidos> = {}): SemanaPedidos => ({
  semana, itensRegistrados: 200, itensImportados: 210, pedidos: 60, atendiveis: 180, ruptura: 10, indeterminados: 6, semLeitura: 4,
  fillRatePct: 94.7, coberturaPct: 95.2, ...o,
});
const prat = (semana: string, o: Partial<SemanaPrateleira> = {}): SemanaPrateleira => ({
  semana, diasLidos: 5, ultimoDia: '2026-10-30', pctSkusSemSaldo: 10.8, pctValorSemSaldo: 6.2, pctSkusSemLeitura: 14.1, skusComVenda90d: 361, ...o,
});

beforeEach(() => sensorMock.mockReset());

describe('CicloRupturaSensor', () => {
  it('sem trilha ainda: travessões, nunca 0%, e explica por quê', () => {
    sensorMock.mockReturnValue({ data: { pedidos: [], prateleira: [] }, isLoading: false, error: null });
    render(<CicloRupturaSensor hoje="2026-10-31" />);
    expect(screen.getByTestId('ruptura-fill-rate')).toHaveTextContent('—');
    expect(screen.getByTestId('ruptura-guardrail')).toHaveTextContent('sem 2 semanas fechadas');
    expect(screen.getByTestId('ruptura-prateleira')).toHaveTextContent('—');
    expect(screen.getByText(/trilha começa na importação seguinte/)).toBeInTheDocument();
    expect(screen.queryByText('0,0%')).toBeNull();
  });

  it('queda > 1 p.p. entre semanas fechadas acende o guardrail; a semana corrente fica fora', () => {
    sensorMock.mockReturnValue({
      data: {
        pedidos: [sem('2026-10-12', { fillRatePct: 96 }), sem('2026-10-19', { fillRatePct: 94.5 }), sem('2026-10-26', { fillRatePct: 40, itensRegistrados: 12 })],
        prateleira: [prat('2026-10-19'), prat('2026-10-26', { pctSkusSemSaldo: 12.3, ultimoDia: '2026-10-31' })],
      },
      isLoading: false, error: null,
    });
    render(<CicloRupturaSensor hoje="2026-10-31" />);
    expect(screen.getByTestId('ruptura-fill-rate')).toHaveTextContent('94,5%');
    const guard = screen.getByTestId('ruptura-guardrail');
    expect(guard).toHaveTextContent('-1,5 p.p.');
    expect(guard.className).toContain('text-status-error');
    expect(screen.getByTestId('ruptura-prateleira')).toHaveTextContent('12,3%');
    expect(screen.getByText(/361 SKUs · sem leitura 14,1% · lido 31\/10/)).toBeInTheDocument();
    const linhas = within(screen.getByTestId('ruptura-semanas')).getAllByRole('row');
    expect(linhas).toHaveLength(4); // cabeçalho + 3 semanas
    expect(linhas[3]).toHaveTextContent('26/10');
    expect(linhas[3]).toHaveTextContent('12');
  });

  it('fill-rate null na view (menos de 20 decididos) aparece como travessão, não como 100%', () => {
    sensorMock.mockReturnValue({
      data: { pedidos: [sem('2026-10-19', { fillRatePct: null, coberturaPct: null })], prateleira: [] },
      isLoading: false, error: null,
    });
    render(<CicloRupturaSensor hoje="2026-10-31" />);
    const linha = within(screen.getByTestId('ruptura-semanas')).getAllByRole('row')[1];
    expect(linha).toHaveTextContent('—');
    expect(linha).not.toHaveTextContent('100');
  });

  it('erro de leitura é dito, não escondido', () => {
    sensorMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('57014') });
    render(<CicloRupturaSensor hoje="2026-10-31" />);
    expect(screen.getByText(/Não foi possível ler o sensor de ruptura/)).toBeInTheDocument();
  });
});
