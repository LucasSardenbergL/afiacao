import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCommercialRole } from '@/hooks/useCommercialRole';

const authMock = vi.fn();
const maybeSingleMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => maybeSingleMock() }) }) }) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({ user: { id: 'u-1' } });
  maybeSingleMock.mockResolvedValue({ data: null, error: null });
});

/**
 * Trava do contrato de autorização gerencial (E1 do FU4).
 *
 * `pode_ver_carteira_completa` — a função SQL que os papéis gerenciais acionam — gateia
 * 68 policies em 34 tabelas (medido em prod 2026-07-18), incluindo ESCRITA em
 * `cliente_tier_preco` (tier de preço) e `venda_excecao_credito`, e leitura de `cmc_ledger`
 * (custo). Enquanto a matriz de capability por recurso×ação não existir, conceder um papel
 * gerencial entrega preço + crédito + custo junto — então o app trata esses papéis como
 * NÃO concedidos, mesmo que a linha exista no banco.
 */
describe('useCommercialRole — trava do contrato gerencial (E1/FU4)', () => {
  it('gerencial no banco NÃO concede canViewManagerial enquanto o contrato v2 não existir', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'gerencial' }, error: null });
    const { result } = renderHook(() => useCommercialRole());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.commercialRole).toBe('gerencial'); // o dado real é preservado
    expect(result.current.canViewManagerial).toBe(false); // mas a capability não é concedida
    expect(result.current.canViewStrategic).toBe(false);
  });

  it('estrategico no banco NÃO concede canViewStrategic', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'estrategico' }, error: null });
    const { result } = renderHook(() => useCommercialRole());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewStrategic).toBe(false);
    expect(result.current.canViewManagerial).toBe(false);
  });

  it('super_admin no banco NÃO concede as capabilities gerenciais', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'super_admin' }, error: null });
    const { result } = renderHook(() => useCommercialRole());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewStrategic).toBe(false);
    expect(result.current.canViewManagerial).toBe(false);
  });

  it('erro na consulta do papel → fail-closed (role null, capabilities false)', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useCommercialRole());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.commercialRole).toBeNull();
    expect(result.current.canViewManagerial).toBe(false);
  });

  it('operacional segue sem capability gerencial (comportamento inalterado)', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'operacional' }, error: null });
    const { result } = renderHook(() => useCommercialRole());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isOperacional).toBe(true);
    expect(result.current.canViewManagerial).toBe(false);
  });
});
