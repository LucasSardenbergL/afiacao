import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// usePersona usa useDisplayAccess; route-tracker é mockado pra inferência ficar determinística.
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: vi.fn() }));
vi.mock('@/lib/dashboard/route-tracker', () => ({ getRouteCounts: vi.fn(() => ({})) }));

import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { DashboardPersonaProvider, useDashboardPersonaContext } from '../DashboardPersonaContext';

const mockedDisplayAccess = vi.mocked(useDisplayAccess);

function Consumer() {
  const { persona, source } = useDashboardPersonaContext();
  return (
    <div>
      <span data-testid="persona">{persona}</span>
      <span data-testid="source">{source}</span>
    </div>
  );
}

describe('DashboardPersonaProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    // Sem lente: master sem cargo comercial nem departamento → persona 'master'
    // (passo 6 do inferPersona, source 'default').
    mockedDisplayAccess.mockReturnValue({
      displayRole: 'master',
      displayIsStaff: true,
      displayIsMaster: true,
      displayIsGestorComercial: false,
      displayIsSalesOnly: false,
      displayCommercialRole: null,
      displayDepartment: null,
      displayLoading: false,
    });
  });

  it('resolve a persona pelo display* do alvo/real (master → master/default)', () => {
    render(<DashboardPersonaProvider><Consumer /></DashboardPersonaProvider>);
    expect(screen.getByTestId('persona').textContent).toBe('master');
    expect(screen.getByTestId('source').textContent).toBe('default');
  });

  it('na lente, persona segue o display* do alvo (vendedor → vendedor)', () => {
    // A troca de persona acontece pela LENTE (display* do alvo), não por override manual.
    mockedDisplayAccess.mockReturnValue({
      displayRole: 'employee',
      displayIsStaff: true,
      displayIsMaster: false,
      displayIsGestorComercial: false,
      displayIsSalesOnly: true,
      displayCommercialRole: 'operacional',
      displayDepartment: 'vendas',
      displayLoading: false,
    });
    render(<DashboardPersonaProvider><Consumer /></DashboardPersonaProvider>);
    expect(screen.getByTestId('persona').textContent).toBe('vendedor');
  });

  it('ignora override legado no localStorage e limpa a chave órfã no boot', () => {
    // Override manual foi APOSENTADO em favor da lente "Ver como". Um valor preso de
    // versões antigas NÃO pode vencer a inferência (inferPersona passo 1) nem sobreviver ao boot.
    localStorage.setItem('dashboardPersonaOverride', 'financeiro');
    render(<DashboardPersonaProvider><Consumer /></DashboardPersonaProvider>);
    expect(screen.getByTestId('persona').textContent).toBe('master'); // não 'financeiro'
    expect(screen.getByTestId('source').textContent).toBe('default'); // não 'manual'
    expect(localStorage.getItem('dashboardPersonaOverride')).toBeNull(); // chave limpa
  });
});
