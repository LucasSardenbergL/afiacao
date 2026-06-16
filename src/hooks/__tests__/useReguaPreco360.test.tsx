import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-real' } }) }));

import { useReguaPreco360 } from '../useReguaPreco360';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

// 7001 abaixo do piso (preco_atual 90 < piso 125); 7003 sem_produto; 7004 sem_preco.
const ROWS = [
  { omie_codigo: 7001, product_id: 'p1', preco_atual: 90, preco_atual_at: '2026-06-06',
    qty_ref: 5, qty_ref_n: 2, qty_ref_source: 'cliente', hide_reason: null,
    cmc: 100, cmc_confiavel: true, aliquota_venda: 0.20, piso_mc: 125, precos_cliente: [90], comparaveis: [] },
  { omie_codigo: 7003, hide_reason: 'sem_produto' },
  { omie_codigo: 7004, product_id: 'p4', hide_reason: 'sem_preco' },
];

describe('useReguaPreco360', () => {
  beforeEach(() => rpcMock.mockReset());

  it('avalia via helper: SKU abaixo do piso → sinal piso; sem_produto/sem_preco não entram', async () => {
    rpcMock.mockResolvedValue({ data: ROWS, error: null });
    const { result } = renderHook(() => useReguaPreco360('cust-1', [7001, 7003, 7004], true), { wrapper });
    await waitFor(() => expect(result.current.reguaByOmie.get(7001)).toBeDefined());
    expect(result.current.reguaByOmie.get(7001)!.result.sinal).toBe('piso');
    expect(result.current.reguaByOmie.get(7001)!.precoAtual).toBe(90); // ÚLTIMO preço real, da RPC
    expect(result.current.reguaByOmie.has(7003)).toBe(false);
    expect(result.current.reguaByOmie.has(7004)).toBe(false);
  });

  it('1 RPC batch para N códigos (não N chamadas)', async () => {
    rpcMock.mockResolvedValue({ data: ROWS, error: null });
    renderHook(() => useReguaPreco360('cust-1', [7001, 7003, 7004], true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith('get_regua_preco_customer360',
      { p_customer: 'cust-1', p_omie_codigos: [7001, 7003, 7004] });
  });

  it('flag off / sem cliente / lista vazia → não chama RPC', async () => {
    renderHook(() => useReguaPreco360('cust-1', [7001], false), { wrapper });
    renderHook(() => useReguaPreco360(undefined, [7001], true), { wrapper });
    renderHook(() => useReguaPreco360('cust-1', [], true), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
