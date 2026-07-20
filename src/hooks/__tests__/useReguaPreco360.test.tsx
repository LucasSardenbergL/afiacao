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

// 7001 abaixo do piso (preco_atual 90 < piso 125); 7003 sem_produto; 7004 sem_preco; 7005 sem_quantidade.
const ROWS = [
  { omie_codigo: 7001, product_id: 'p1', preco_atual: 90, preco_atual_at: '2026-06-06',
    qty_ref: 10, qty_ref_source: 'ultima_venda', hide_reason: null,
    abaixo_piso: true, piso_disponivel: true, cmc_confiavel: true, prazo_aplicado: false,
    piso_mc: 125, piso_gap_pct: 0.388889, precos_cliente: [90], comparaveis: [] },
  { omie_codigo: 7003, hide_reason: 'sem_produto' },
  { omie_codigo: 7004, product_id: 'p4', hide_reason: 'sem_preco' },
  { omie_codigo: 7005, product_id: 'p5', preco_atual: 100, preco_atual_at: '2026-06-10', hide_reason: 'sem_quantidade' },
];
const CODES = [7001, 7003, 7004, 7005];

describe('useReguaPreco360', () => {
  beforeEach(() => rpcMock.mockReset());

  it('avalia via helper: SKU abaixo do piso → sinal piso; hide_reason (produto/preço/qtd) não entram', async () => {
    rpcMock.mockResolvedValue({ data: ROWS, error: null });
    const { result } = renderHook(() => useReguaPreco360('cust-1', CODES, true), { wrapper });
    await waitFor(() => expect(result.current.reguaByOmie.get(7001)).toBeDefined());
    expect(result.current.reguaByOmie.get(7001)!.result.sinal).toBe('piso');
    expect(result.current.reguaByOmie.get(7001)!.precoAtual).toBe(90); // ÚLTIMO preço real, da RPC
    expect(result.current.reguaByOmie.has(7003)).toBe(false);
    expect(result.current.reguaByOmie.has(7004)).toBe(false);
    expect(result.current.reguaByOmie.has(7005)).toBe(false);
  });

  it('1 RPC batch para N códigos (não N chamadas)', async () => {
    rpcMock.mockResolvedValue({ data: ROWS, error: null });
    renderHook(() => useReguaPreco360('cust-1', CODES, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith('get_regua_preco_customer360',
      { p_customer: 'cust-1', p_omie_codigos: CODES });
  });

  it('fail-closed: enabled true→false esvazia reguaByOmie mesmo com cache (rollback por flag)', async () => {
    rpcMock.mockResolvedValue({ data: ROWS, error: null });
    const { result, rerender } = renderHook(
      ({ en }: { en: boolean }) => useReguaPreco360('cust-1', [7001], en),
      { wrapper, initialProps: { en: true } },
    );
    await waitFor(() => expect(result.current.reguaByOmie.get(7001)).toBeDefined());
    rerender({ en: false });
    expect(result.current.reguaByOmie.size).toBe(0);
  });

  it('flag off / sem cliente / lista vazia → não chama RPC', async () => {
    renderHook(() => useReguaPreco360('cust-1', [7001], false), { wrapper });
    renderHook(() => useReguaPreco360(undefined, [7001], true), { wrapper });
    renderHook(() => useReguaPreco360('cust-1', [], true), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
