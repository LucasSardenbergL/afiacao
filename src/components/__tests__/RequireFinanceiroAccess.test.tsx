import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequireFinanceiroAccess } from '../RequireFinanceiroAccess';
import { useAuth } from '@/contexts/AuthContext';
import { getMinhaPermissao } from '@/services/financeiroV2Service';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/services/financeiroV2Service', () => ({ getMinhaPermissao: vi.fn() }));
// RequireFinanceiroAccess usa ImpersonationContext e useDisplayAccess;
// nos testes fora da lente, isImpersonating=false e displayIsStaff espelha isStaff real.
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: vi.fn(() => ({ isImpersonating: false })) }));
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: vi.fn() }));

const mockUseAuth = vi.mocked(useAuth);
const mockGetPerm = vi.mocked(getMinhaPermissao);
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
const mockUseDisplayAccess = vi.mocked(useDisplayAccess);

function renderGuard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/financeiro']}>
        <Routes>
          <Route element={<RequireFinanceiroAccess />}>
            <Route path="/financeiro" element={<div>CONTEUDO FINANCEIRO</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireFinanceiroAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Por padrão: fora da lente, display* espelha o real
    mockUseDisplayAccess.mockReturnValue({
      displayIsStaff: false,
      displayLoading: false,
      displayRole: null,
      displayIsMaster: false,
      displayIsGestorComercial: false,
      displayIsSalesOnly: false,
      displayCommercialRole: null, displayDepartment: null,
    });
  });

  it('libera staff sem buscar fin_permissoes', async () => {
    mockUseAuth.mockReturnValue({ isStaff: true, loading: false } as unknown as ReturnType<typeof useAuth>);
    mockUseDisplayAccess.mockReturnValue({
      displayIsStaff: true, displayLoading: false,
      displayRole: 'employee', displayIsMaster: false,
      displayIsGestorComercial: false, displayIsSalesOnly: false, displayCommercialRole: null, displayDepartment: null,
    });
    renderGuard();
    expect(await screen.findByText('CONTEUDO FINANCEIRO')).toBeTruthy();
    expect(mockGetPerm).not.toHaveBeenCalled();
  });

  it('bloqueia customer (sem staff, sem permissão)', async () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: false } as unknown as ReturnType<typeof useAuth>);
    mockGetPerm.mockResolvedValue(null);
    renderGuard();
    expect(await screen.findByText('Sem acesso ao Financeiro')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO FINANCEIRO')).toBeNull();
  });

  it('libera não-staff com fin_permissoes', async () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: false } as unknown as ReturnType<typeof useAuth>);
    mockGetPerm.mockResolvedValue({ id: 'x', pode_ver_todas_empresas: true } as Awaited<ReturnType<typeof getMinhaPermissao>>);
    renderGuard();
    expect(await screen.findByText('CONTEUDO FINANCEIRO')).toBeTruthy();
  });
});
