import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// usePersona agora usa useDisplayAccess em vez de useAuth/useCommercialRole/etc.
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: vi.fn() }));
vi.mock('@/lib/dashboard/route-tracker', () => ({ getRouteCounts: vi.fn(() => ({})) }));

import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { DashboardPersonaProvider, useDashboardPersonaContext } from '../DashboardPersonaContext';

const mockedDisplayAccess = vi.mocked(useDisplayAccess);

function Consumer() {
  const { persona, source, setOverride, clearOverride } = useDashboardPersonaContext();
  return (
    <div>
      <span data-testid="persona">{persona}</span>
      <span data-testid="source">{source}</span>
      <button onClick={() => setOverride('vendedor')}>vendedor</button>
      <button onClick={() => clearOverride()}>clear</button>
    </div>
  );
}

describe('DashboardPersonaProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    // Sem lente: master sem cargo comercial específico → persona 'master' (passo 6 do inferPersona).
    // displayIsGestorComercial=false pois o master sem commercialRole não entra no passo 4.
    mockedDisplayAccess.mockReturnValue({
      displayRole: 'master',
      displayIsStaff: true,
      displayIsMaster: true,
      displayIsGestorComercial: false,
      displayIsSalesOnly: false,
      displayDepartment: null,
      displayLoading: false,
    });
  });

  it('troca de persona reativamente quando setOverride é chamado (sem reload)', () => {
    render(<DashboardPersonaProvider><Consumer /></DashboardPersonaProvider>);
    expect(screen.getByTestId('persona').textContent).toBe('master');
    expect(screen.getByTestId('source').textContent).toBe('default');
    act(() => { screen.getByText('vendedor').click(); });
    expect(screen.getByTestId('persona').textContent).toBe('vendedor');
    expect(screen.getByTestId('source').textContent).toBe('manual');
  });

  it('persiste o override no localStorage e limpa com clearOverride', () => {
    render(<DashboardPersonaProvider><Consumer /></DashboardPersonaProvider>);
    act(() => { screen.getByText('vendedor').click(); });
    expect(localStorage.getItem('dashboardPersonaOverride')).toBe('vendedor');
    act(() => { screen.getByText('clear').click(); });
    expect(localStorage.getItem('dashboardPersonaOverride')).toBeNull();
    expect(screen.getByTestId('persona').textContent).toBe('master');
  });

  it('inicializa a partir do override persistido no localStorage', () => {
    localStorage.setItem('dashboardPersonaOverride', 'financeiro');
    render(<DashboardPersonaProvider><Consumer /></DashboardPersonaProvider>);
    expect(screen.getByTestId('persona').textContent).toBe('financeiro');
    expect(screen.getByTestId('source').textContent).toBe('manual');
  });
});
