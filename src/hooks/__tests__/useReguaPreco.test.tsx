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

const FETCH_PISO = { abaixo_piso: true, piso_disponivel: true, cmc_confiavel: true,
  prazo_aplicado: false, piso_mc: 106.29, piso_gap_pct: 0.0027,
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

  // FU4-F fase 2: o preço passou a ser ARGUMENTO da RPC (a comparação preço<piso é do servidor).
  it('manda p_preco_atual e p_prazo_dias para a RPC', async () => {
    rpcMock.mockResolvedValue({ data: FETCH_PISO, error: null });
    const itens: ReguaCartItem[] = [{ chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 }];
    renderHook(() => useReguaPreco(itens, 'cust-1', true, { prazoDias: [0, 30] }), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith('get_regua_preco', {
      p_customer: 'cust-1', p_product: 'p1', p_qty: 2,
      p_preco_atual: 100, p_prazo_dias: [0, 30],
    });
  });

  // Sem debounce, cada tecla no campo de preço viraria uma RPC — 4 edições = 4 chamadas por item.
  // A 1ª carga NÃO é atrasada de propósito (useDebouncedValue inicializa com o valor), então o
  // esperado é: 1 chamada inicial + 1 pela rajada inteira = 2, nunca 5.
  it('rajada de mudanças de preço colapsa (debounce) e converge no último preço', async () => {
    rpcMock.mockResolvedValue({ data: FETCH_PISO, error: null });
    const { rerender } = renderHook(
      ({ preco }: { preco: number }) =>
        useReguaPreco([{ chave: 'k1', productId: 'p1', qty: 2, precoAtual: preco }], 'cust-1', true),
      { wrapper, initialProps: { preco: 100 } },
    );
    for (const preco of [101, 102, 103, 104]) rerender({ preco });
    await waitFor(() =>
      expect(rpcMock).toHaveBeenLastCalledWith('get_regua_preco', expect.objectContaining({ p_preco_atual: 104 })),
    );
    expect(rpcMock.mock.calls.length).toBeLessThanOrEqual(2); // 5 edições, ≤2 chamadas
  });

  it('flag off ou sem cliente → não chama RPC', async () => {
    const itens: ReguaCartItem[] = [{ chave: 'k1', productId: 'p1', qty: 2, precoAtual: 100 }];
    renderHook(() => useReguaPreco(itens, null, true), { wrapper });
    renderHook(() => useReguaPreco(itens, 'cust-1', false), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
