import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-real' } }) }));

import { useReguaPreco } from '../useReguaPreco';
import type { ReguaCartItem } from '@/lib/regua-preco/regua-preco-ui';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const FETCH_PISO = { cmc: 98, cmc_confiavel: true, aliquota_venda: 0.078, piso_mc: 106.29,
  precos_cliente: [], comparaveis: [] };

describe('useReguaPreco', () => {
  beforeEach(() => rpcMock.mockReset());

  it('aplica o helper: preço abaixo do piso de MC → sinal piso', async () => {
    rpcMock.mockResolvedValue({ data: FETCH_PISO, error: null });
    const itens: ReguaCartItem[] = [{ chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 }];
    const { result } = renderHook(() => useReguaPreco(itens, 'cust-1', true), { wrapper });
    await waitFor(() => expect(result.current.reguaByKey.get('k1')).toBeDefined());
    expect(result.current.reguaByKey.get('k1')!.sinal).toBe('piso');
    expect(result.current.reguaByKey.get('k1')!.abaixoPiso).toBe(true);
  });

  it('dedup: dois itens mesmo (produto,qty) disparam 1 só RPC', async () => {
    rpcMock.mockResolvedValue({ data: FETCH_PISO, error: null });
    const itens: ReguaCartItem[] = [
      { chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 },
      { chave: 'k2', productId: 'p1', qty: 2, precoAtual: 100 },
    ];
    renderHook(() => useReguaPreco(itens, 'cust-1', true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
  });

  it('flag off ou sem cliente → não chama RPC', async () => {
    const itens: ReguaCartItem[] = [{ chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 }];
    renderHook(() => useReguaPreco(itens, null, true), { wrapper });
    renderHook(() => useReguaPreco(itens, 'cust-1', false), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
