import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/components/sales/print/buscarDescontosItens', () => ({ buscarDescontosItens: vi.fn() }));

import { buscarDescontosItens } from '@/components/sales/print/buscarDescontosItens';
import { descontosItensQueryKey, useDescontosItensPedido } from '../useDescontosItensPedido';

const buscar = vi.mocked(buscarDescontosItens);
const LINHAS = [{ omie_codigo_produto: 8689791246, quantity: 1, unit_price: 460.25, desconto_valor: 23.01 }];

const novoClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function montar(row: Parameters<typeof useDescontosItensPedido>[0], qc = novoClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useDescontosItensPedido(row), { wrapper });
}

beforeEach(() => {
  buscar.mockReset();
});

describe('useDescontosItensPedido — a leitura de order_items do painel', () => {
  it('lê o MESMO cache que o cupom aquece no hover (chave compartilhada), sem buscar de novo', () => {
    const qc = novoClient();
    qc.setQueryData(descontosItensQueryKey('u1', 'p1'), { p1: LINHAS });
    const { result } = montar({ origin: 'sales', id: 'p1' }, qc);
    expect(result.current.data).toEqual({ p1: LINHAS });
    expect(buscar).not.toHaveBeenCalled();
  });

  it('cache frio: busca order_items só deste pedido', async () => {
    buscar.mockResolvedValue({ p1: LINHAS });
    const { result } = montar({ origin: 'sales', id: 'p1' });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(buscar).toHaveBeenCalledWith(['p1']);
    expect(result.current.data).toEqual({ p1: LINHAS });
  });

  it('pedido de afiação não pergunta: não tem order_items', () => {
    const { result } = montar({ origin: 'afiacao', id: 'a1' });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.status).toBe('pending');
    expect(buscar).not.toHaveBeenCalled();
  });

  it('sem pedido selecionado não pergunta', () => {
    const { result } = montar(null);
    expect(result.current.fetchStatus).toBe('idle');
    expect(buscar).not.toHaveBeenCalled();
  });
});
