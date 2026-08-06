import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useCommercialRole } from '@/hooks/useCommercialRole';

const authMock = vi.fn();
const maybeSingleMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => maybeSingleMock() }) }) }),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

/** Cada teste ganha um QueryClient próprio: cache compartilhado vazaria a versão entre casos. */
function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

/** Banco no contrato v2 = matriz de capability aplicada. */
const bancoEmV2 = () => rpcMock.mockResolvedValue({ data: 2, error: null });
/** Banco no contrato v1 = gate único ainda vigente (migration da E2 não aplicada). */
const bancoEmV1 = () => rpcMock.mockResolvedValue({ data: 1, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({ user: { id: 'u-1' } });
  maybeSingleMock.mockResolvedValue({ data: null, error: null });
  bancoEmV2();
});

/**
 * Contrato de autorização gerencial (E1 #1424 → E2/FU4, spec 2026-07-18).
 *
 * `pode_ver_carteira_completa` — a função que os papéis gerenciais acionavam — gateava
 * 64 policies em 34 tabelas (medido em prod 2026-07-18), incluindo ESCRITA em
 * `cliente_tier_preco` (tier de preço) e `venda_excecao_credito` (crédito), e LEITURA de
 * `cmc_ledger` (custo). A E2 trocou esse gate único por uma matriz por recurso × ação.
 *
 * A capability agora depende do BANCO, não de uma constante: o app só concede o papel quando
 * `authz_contract_version() >= 2`. Isso existe porque no Lovable a migration é aplicada à mão e
 * falha em silêncio — publicar o frontend sem ela reabriria o furo sem nenhum sinal.
 */
describe('useCommercialRole — contrato v1 (matriz NÃO aplicada): fail-closed', () => {
  beforeEach(bancoEmV1);

  it('gerencial no banco NÃO concede canViewManagerial se o contrato ainda é v1', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'gerencial' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.commercialRole).toBe('gerencial'); // o dado real é preservado
    expect(result.current.canViewManagerial).toBe(false); // mas a capability não é concedida
    expect(result.current.canViewStrategic).toBe(false);
  });

  it('estrategico no banco NÃO concede canViewStrategic se o contrato ainda é v1', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'estrategico' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewStrategic).toBe(false);
    expect(result.current.canViewManagerial).toBe(false);
  });

  it('super_admin no banco NÃO concede as capabilities se o contrato ainda é v1', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'super_admin' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewStrategic).toBe(false);
    expect(result.current.canViewManagerial).toBe(false);
  });

  it('RPC ausente (migration não aplicada → 404) → fail-closed', async () => {
    // O caso que mais importa: deu Publish no frontend e esqueceu a migration.
    rpcMock.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'gerencial' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });

    // Espera o PAPEL carregar (caminho independente da RPC). Não se espera `loading` virar
    // false aqui: a consulta do contrato ainda está em retry — e durante o retry a capability
    // já tem de estar negada, que é justamente o que este teste prova.
    await waitFor(() => expect(result.current.commercialRole).toBe('gerencial'));

    expect(result.current.canViewManagerial).toBe(false);
    expect(result.current.canViewStrategic).toBe(false);
  });
});

describe('useCommercialRole — contrato v2 (matriz aplicada): capability concedida', () => {
  it('gerencial concede canViewManagerial, mas NÃO canViewStrategic', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'gerencial' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewManagerial).toBe(true);
    expect(result.current.canViewStrategic).toBe(false);
  });

  it('estrategico concede as duas', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'estrategico' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewStrategic).toBe(true);
    expect(result.current.canViewManagerial).toBe(true);
  });

  it('super_admin concede as duas', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'super_admin' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewStrategic).toBe(true);
    expect(result.current.canViewManagerial).toBe(true);
  });

  it('operacional NÃO ganha capability gerencial nem com a matriz aplicada', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'operacional' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isOperacional).toBe(true);
    expect(result.current.canViewManagerial).toBe(false);
    expect(result.current.canViewStrategic).toBe(false);
  });

  // ── Os papéis que EXISTEM em produção ────────────────────────────────────────────────────────
  // Distribuição real medida por psql-ro em 2026-07-29: farmer=2, master=1, super_admin=ZERO. Os
  // testes acima cobrem só os quatro valores que o TIPO conhecia — nenhum deles atribuído a ninguém.
  // O tipo negava 'master'/'farmer', e o `as CommercialRole` do fetch escondia a divergência, então
  // esta suíte inteira provava um mundo que não existe. Estes dois fixam o mundo real.
  it('master (o papel do dono do sistema) atravessa o cast e chega intacto', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'master' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.commercialRole).toBe('master');
    expect(result.current.isSuperAdmin).toBe(false); // 'master' ≠ 'super_admin' — papéis distintos
  });

  it('farmer idem (2 usuários em prod)', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'farmer' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.commercialRole).toBe('farmer');
    expect(result.current.isSuperAdmin).toBe(false);
  });

  // ⚠️ DOCUMENTA UM ACHADO, NÃO O CORRIGE. Nenhum dos papéis realmente atribuídos concede as
  // capabilities: os predicados comparam contra operacional/gerencial/estrategico/super_admin, e
  // ninguém tem nenhum deles. Na prática canViewManagerial/Strategic são false para 100% da base.
  // Não é regressão desta mudança — é o estado que ela tornou VISÍVEL, e mexer nisso é decisão de
  // autorização com superfície própria (governa também 5 telas de Governança). O assert existe para
  // que uma correção futura falhe aqui de propósito, em vez de mudar autorização em silêncio.
  it('ACHADO: nenhum papel real de prod concede capability (master inclusive)', async () => {
    maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'master' }, error: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canViewManagerial).toBe(false);
    expect(result.current.canViewStrategic).toBe(false);
  });

  it('erro na consulta do PAPEL → fail-closed mesmo com o contrato em v2', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.commercialRole).toBeNull();
    expect(result.current.canViewManagerial).toBe(false);
  });

  it('sem usuário logado → sem capability', async () => {
    authMock.mockReturnValue({ user: null });
    const { result } = renderHook(() => useCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.commercialRole).toBeNull();
    expect(result.current.canViewManagerial).toBe(false);
  });
});
