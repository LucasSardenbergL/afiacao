import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/useCommercialRole', () => ({ useCommercialRole: vi.fn() }));
vi.mock('@/hooks/useSalesOnlyRestriction', () => ({ useSalesOnlyRestriction: vi.fn() }));
vi.mock('@/hooks/useUserDepartment', () => ({ useUserDepartment: vi.fn() }));
vi.mock('@/lib/dashboard/route-tracker', () => ({ getRouteCounts: vi.fn(() => ({})) }));

import { useAuth } from '@/contexts/AuthContext';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
import { useUserDepartment } from '@/hooks/useUserDepartment';
import { DashboardPersonaProvider, useDashboardPersonaContext } from '../DashboardPersonaContext';

const mockedUseAuth = vi.mocked(useAuth);
const mockedCommercial = vi.mocked(useCommercialRole);
const mockedSalesOnly = vi.mocked(useSalesOnlyRestriction);
const mockedDept = vi.mocked(useUserDepartment);

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
    mockedUseAuth.mockReturnValue({ role: 'master' } as ReturnType<typeof useAuth>);
    mockedCommercial.mockReturnValue({ commercialRole: null } as ReturnType<typeof useCommercialRole>);
    mockedSalesOnly.mockReturnValue(false);
    mockedDept.mockReturnValue({ department: null } as ReturnType<typeof useUserDepartment>);
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
