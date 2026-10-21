import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpcMock(...a),
    // venda_config.onda_recompra = true (a Onda 1 ligada no servidor)
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { valor: true }, error: null }) }) }),
    }),
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'master-real' } }) }));
const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));

import { useMinhasSugestoes } from '@/hooks/useMinhasSugestoes';

const RESP = {
  dia: '2026-10-24',
  ondas: { recompra: true, complemento: false, preco: false },
  compradores: [{
    comprador_id: 'c1', nome: 'Marcenaria', telefone: null, motivo_entrada: 'atraso', valor_ref_total: null,
    sugestoes: [{ id: 's1', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 1, descricao: null, familia: null,
      qtd_ref: null, valor_ref: null, preco_alvo: null, cadencia_dias: null }],
  }],
};

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ data: RESP, error: null });
});

describe('useMinhasSugestoes na lente "Ver como"', () => {
  it('lê a lista da pessoa VISTA pela RPC master-only get_ (nunca a do master por auth.uid())', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'regina' });
    const { result } = renderHook(() => useMinhasSugestoes(), { wrapper });
    await waitFor(() => expect(result.current.estado.tipo).toBe('pronta'));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('get_venda_sugestoes_for', { p_farmer: 'regina' });
    expect(rpcMock).not.toHaveBeenCalledWith('venda_minhas_sugestoes');
    const estado = result.current.estado;
    expect(estado.tipo === 'pronta' && estado.resp.compradores[0].compradorId).toBe('c1');
  });

  it('fora da lente segue a RPC da própria farmer, sem p_farmer', async () => {
    impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-real' });
    const { result } = renderHook(() => useMinhasSugestoes(), { wrapper });
    await waitFor(() => expect(result.current.estado.tipo).toBe('pronta'));
    expect(rpcMock).toHaveBeenCalledWith('venda_minhas_sugestoes');
    expect(rpcMock).not.toHaveBeenCalledWith('get_venda_sugestoes_for', expect.anything());
  });

  it('erro da RPC na lente vira estado de erro, nunca lista vazia', async () => {
    impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'regina' });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'get_venda_sugestoes_for: so master', code: '42501' } });
    const { result } = renderHook(() => useMinhasSugestoes(), { wrapper });
    await waitFor(() => expect(result.current.estado.tipo).toBe('erro'));
  });
});
