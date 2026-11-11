import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Plano v8, C13 — a ponta de TELA: com contagem falhada a faixa não pode dizer "Sem mudanças".
 * A âncora é `data-testid="deltas-falha"`, não a copy.
 */

type Retorno = {
  deltas: { type: string; label: string; singular: string; value: number; path: string }[];
  falhas: string[];
  isLoading: boolean;
  isEmpty: boolean;
};
let retorno: Retorno;

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/contexts/DashboardPersonaContext', () => ({
  useDashboardPersonaContext: () => ({ persona: 'master' }),
}));
vi.mock('@/hooks/useLastVisit', () => ({
  useLastVisit: () => ({ lastVisitIso: '2026-11-10T12:00:00.000Z', minutesSinceLastVisit: 600 }),
}));
vi.mock('@/hooks/dashboard/useBriefDeltas', () => ({ useBriefDeltas: () => retorno }));

import { DeltasStrip } from '../DeltasStrip';

const PEDIDOS = { type: 'sales_new', label: 'pedidos', singular: 'pedido', value: 3, path: '/sales' };

beforeEach(() => {
  retorno = { deltas: [], falhas: [], isLoading: false, isEmpty: true };
});

describe('DeltasStrip — falha de contagem', () => {
  it('CONTROLE: tudo lido e nada novo → "Sem mudanças", sem aviso', () => {
    render(<DeltasStrip />);
    expect(screen.queryByTestId('deltas-falha')).toBeNull();
    expect(screen.getByText(/Sem mudan/)).toBeTruthy();
  });

  it('nada novo MAS uma contagem falhou → aviso, e NÃO "Sem mudanças"', () => {
    retorno = { ...retorno, falhas: ['NF chegaram'] };
    render(<DeltasStrip />);
    expect(screen.getByTestId('deltas-falha').textContent).toContain('NF chegaram');
    expect(screen.queryByText(/Sem mudan/)).toBeNull();
  });

  it('com novidade e uma falha → os bullets E o aviso', () => {
    retorno = { deltas: [PEDIDOS], falhas: ['orçamentos enviados'], isLoading: false, isEmpty: false };
    render(<DeltasStrip />);
    expect(screen.getByText(/3 pedidos/)).toBeTruthy();
    expect(screen.getByTestId('deltas-falha').textContent).toContain('orçamentos enviados');
  });
});
