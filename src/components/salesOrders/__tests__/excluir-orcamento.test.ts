import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resp: { data: null as unknown, error: null as unknown },
  edge: { data: null as unknown, error: null as unknown },
  eq: vi.fn(), select: vi.fn(), invoke: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      delete: () => ({
        eq: (...a: unknown[]) => {
          h.eq(...a);
          return { select: (...b: unknown[]) => { h.select(...b); return Promise.resolve(h.resp); } };
        },
      }),
    }),
    functions: { invoke: (...a: unknown[]) => { h.invoke(...a); return Promise.resolve(h.edge); } },
  },
}));

import { excluirOrcamento } from '../excluir-orcamento';

beforeEach(() => { h.eq.mockReset(); h.select.mockReset(); h.invoke.mockReset(); h.edge = { data: { success: true }, error: null }; });

describe('excluirOrcamento', () => {
  it('nunca enviado (o DELETE direto apagou 1 linha): resolve sem chamar a edge', async () => {
    h.resp = { data: [{ id: 'q1' }], error: null };
    await expect(excluirOrcamento('q1')).resolves.toBeUndefined();
    expect(h.eq).toHaveBeenCalledWith('id', 'q1');
    expect(h.select).toHaveBeenCalledWith('id');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('RLS barrou (0 linhas — já passou por envio): vai pela edge excluir_pedido, que confere o Omie', async () => {
    h.resp = { data: [], error: null };
    await expect(excluirOrcamento('q1')).resolves.toBeUndefined();
    expect(h.invoke).toHaveBeenCalledWith('omie-vendas-sync', {
      body: { action: 'excluir_pedido', sales_order_id: 'q1', omie_pedido_id: null },
    });
  });

  it('a edge recusa (ex.: PV existe no Omie): RECUSA com o motivo, nunca "excluído"', async () => {
    h.resp = { data: [], error: null };
    h.edge = { data: null, error: { message: 'Exclusão recusada: o pedido existe no Omie (PV 9).' } };
    await expect(excluirOrcamento('q1')).rejects.toThrow('existe no Omie');
  });

  it('erro do PostgREST no DELETE: propaga sem chamar a edge', async () => {
    h.resp = { data: null, error: { message: 'rls' } };
    await expect(excluirOrcamento('q1')).rejects.toEqual({ message: 'rls' });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
