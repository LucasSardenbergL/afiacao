import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));
import { supabase } from '@/integrations/supabase/client';
import { useItensDosPedidos } from '../useItensDosPedidos';

let chamadas: { table: string; select?: string; inCol?: string; inVals?: unknown[] }[] = [];
let linhas: unknown[] = [];
function builder(table: string) {
  const c: (typeof chamadas)[number] = { table };
  chamadas.push(c);
  const b = {
    select: (cols: string) => { c.select = cols; return b; },
    in: (col: string, vals: unknown[]) => { c.inCol = col; c.inVals = vals; return b; },
    order: () => b,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(res, rej),
  };
  return b;
}
function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => { chamadas = []; linhas = []; vi.mocked(supabase.from).mockReset().mockImplementation(builder as never); });

describe('useItensDosPedidos — itens de todos os pedidos do ciclo numa query só (sem N+1)', () => {
  it('uma única query .in("pedido_id", ids ordenados) e o mapa por pedido', async () => {
    linhas = [
      { id: 501, pedido_id: 2, qtde_final: 40, qtde_sugerida: 40, preco_unitario: 12.5, fator_embalagem_portal: null },
      { id: 502, pedido_id: 1, qtde_final: 3, qtde_sugerida: 3, preco_unitario: 9, fator_embalagem_portal: 0.2 },
      { id: 503, pedido_id: 1, qtde_final: 8, qtde_sugerida: 8, preco_unitario: 1, fator_embalagem_portal: null },
    ];
    const { result } = renderHook(() => useItensDosPedidos([3, 1, 2]), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].table).toBe('pedido_compra_item');
    expect(chamadas[0].inCol).toBe('pedido_id');
    expect(chamadas[0].inVals).toEqual([1, 2, 3]);
    expect(chamadas[0].select).toContain('fator_embalagem_portal');
    const m = result.current.data!;
    expect(m.get(1)?.map((i) => i.id)).toEqual([502, 503]);
    expect(m.get(2)?.map((i) => i.id)).toEqual([501]);
    expect(m.get(3)).toBeUndefined(); // pedido sem itens → o painel traduz para []
  });

  it('sem ids não consulta nada', async () => {
    const { result } = renderHook(() => useItensDosPedidos([]), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas).toEqual([]);
    expect(result.current.data).toBeUndefined();
  });

  it('bater na capa de 1.000 linhas do PostgREST é ERRO, não mapa parcial (leitura parcial ≠ verdade)', async () => {
    linhas = Array.from({ length: 1000 }, (_, i) => ({ id: i, pedido_id: 1, qtde_final: 1, qtde_sugerida: 1, preco_unitario: 1, fator_embalagem_portal: null }));
    const { result } = renderHook(() => useItensDosPedidos([1]), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
