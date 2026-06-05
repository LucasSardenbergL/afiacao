import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';

const authMock = vi.fn();
const impMock = vi.fn();
const profileMock = vi.fn();
const salesOnlyMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useImpersonatedAccessProfile', () => ({ useImpersonatedAccessProfile: () => profileMock() }));
vi.mock('@/hooks/useSalesOnlyRestriction', () => ({ useSalesOnlyRestriction: () => salesOnlyMock() }));

beforeEach(() => {
  authMock.mockReturnValue({ role: 'master', isStaff: true, isMaster: true, isGestorComercial: true });
  impMock.mockReturnValue({ isImpersonating: false, target: null });
  profileMock.mockReturnValue({ data: null, isLoading: false });
  salesOnlyMock.mockReturnValue(false);
});

describe('useDisplayAccess', () => {
  it('sem lente: espelha o acesso real do master', () => {
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: 'master', displayIsStaff: true, displayIsMaster: true,
      displayIsGestorComercial: true, displayIsSalesOnly: false, displayLoading: false,
    });
  });

  it('sem lente: reflete sales-only real', () => {
    salesOnlyMock.mockReturnValue(true);
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current.displayIsSalesOnly).toBe(true);
  });

  it('na lente, alvo vendedor employee: rebaixa master->employee', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'v1', nome: 'Regina', grupo: 'farmer' } });
    profileMock.mockReturnValue({ data: { appRole: 'employee', commercialRole: 'operacional', department: 'vendas', isSalesOnly: true }, isLoading: false });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: 'employee', displayIsStaff: true, displayIsMaster: false,
      displayIsGestorComercial: false, displayIsSalesOnly: true, displayDepartment: 'vendas', displayLoading: false,
    });
  });

  it('na lente, alvo gestor: displayIsGestorComercial=true', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'g1', nome: 'X', grupo: null } });
    profileMock.mockReturnValue({ data: { appRole: 'employee', commercialRole: 'gerencial', department: 'gestao', isSalesOnly: false }, isLoading: false });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current.displayIsGestorComercial).toBe(true);
    expect(result.current.displayIsMaster).toBe(false);
  });

  it('na lente, perfil ainda carregando: rebaixa tudo + displayLoading=true', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'v1', nome: 'Regina', grupo: 'farmer' } });
    profileMock.mockReturnValue({ data: null, isLoading: true });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: null, displayIsStaff: false, displayIsMaster: false, displayLoading: true,
    });
  });
});
