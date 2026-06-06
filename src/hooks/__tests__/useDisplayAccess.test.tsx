import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';

const authMock = vi.fn();
const impMock = vi.fn();
const profileMock = vi.fn();
const salesOnlyMock = vi.fn();
const commercialMock = vi.fn();
const deptMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useImpersonatedAccessProfile', () => ({ useImpersonatedAccessProfile: () => profileMock() }));
vi.mock('@/hooks/useSalesOnlyRestriction', () => ({ useSalesOnlyRestriction: () => salesOnlyMock() }));
vi.mock('@/hooks/useCommercialRole', () => ({ useCommercialRole: () => commercialMock() }));
vi.mock('@/hooks/useUserDepartment', () => ({ useUserDepartment: () => deptMock() }));

beforeEach(() => {
  authMock.mockReturnValue({ role: 'master', isStaff: true, isMaster: true, isGestorComercial: true });
  impMock.mockReturnValue({ isImpersonating: false, target: null });
  profileMock.mockReturnValue({ data: null, isLoading: false });
  salesOnlyMock.mockReturnValue(false);
  commercialMock.mockReturnValue({ commercialRole: 'super_admin' });
  deptMock.mockReturnValue({ department: null });
});

describe('useDisplayAccess', () => {
  it('sem lente: espelha o acesso real do master (incl. cargo comercial cru e departamento)', () => {
    deptMock.mockReturnValue({ department: 'gestao' });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: 'master', displayIsStaff: true, displayIsMaster: true,
      displayIsGestorComercial: true, displayIsSalesOnly: false,
      displayCommercialRole: 'super_admin', displayDepartment: 'gestao', displayLoading: false,
    });
  });

  it('sem lente: displayCommercialRole reflete o cargo real (super_admin NÃO vira gerencial)', () => {
    // Trava a regressão: a inferência de persona não pode rebaixar master super_admin -> gestor.
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current.displayCommercialRole).toBe('super_admin');
  });

  it('sem lente: reflete sales-only real', () => {
    salesOnlyMock.mockReturnValue(true);
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current.displayIsSalesOnly).toBe(true);
  });

  it('na lente, alvo vendedor employee: rebaixa master->employee (cargo/dept do alvo)', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'v1', nome: 'Regina', grupo: 'farmer' } });
    profileMock.mockReturnValue({ data: { appRole: 'employee', commercialRole: 'operacional', department: 'vendas', isSalesOnly: true }, isLoading: false });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: 'employee', displayIsStaff: true, displayIsMaster: false,
      displayIsGestorComercial: false, displayIsSalesOnly: true,
      displayCommercialRole: 'operacional', displayDepartment: 'vendas', displayLoading: false,
    });
  });

  it('na lente, alvo gestor: displayIsGestorComercial=true e displayCommercialRole=gerencial', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'g1', nome: 'X', grupo: null } });
    profileMock.mockReturnValue({ data: { appRole: 'employee', commercialRole: 'gerencial', department: 'gestao', isSalesOnly: false }, isLoading: false });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current.displayIsGestorComercial).toBe(true);
    expect(result.current.displayCommercialRole).toBe('gerencial');
    expect(result.current.displayIsMaster).toBe(false);
  });

  it('na lente, perfil ainda carregando: rebaixa tudo + displayLoading=true', () => {
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'v1', nome: 'Regina', grupo: 'farmer' } });
    profileMock.mockReturnValue({ data: null, isLoading: true });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: null, displayIsStaff: false, displayIsMaster: false,
      displayCommercialRole: null, displayLoading: true,
    });
  });

  it('na lente, perfil settled SEM dado (RPC falhou/vazia): rebaixa + displayLoading=false (NÃO eterno)', () => {
    // Trava a regressão do loading eterno: isLoading=false + data=null não pode manter displayLoading=true.
    impMock.mockReturnValue({ isImpersonating: true, target: { id: 'v1', nome: 'Regina', grupo: 'farmer' } });
    profileMock.mockReturnValue({ data: null, isLoading: false });
    const { result } = renderHook(() => useDisplayAccess());
    expect(result.current).toMatchObject({
      displayRole: null, displayIsStaff: false, displayIsMaster: false,
      displayCommercialRole: null, displayLoading: false,
    });
  });
});
