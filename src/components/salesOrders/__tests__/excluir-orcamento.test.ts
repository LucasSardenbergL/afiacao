import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ resp: { data: null as unknown, error: null as unknown }, eq: vi.fn(), select: vi.fn() }));
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
  },
}));

import { excluirOrcamento } from '../excluir-orcamento';

beforeEach(() => { h.eq.mockReset(); h.select.mockReset(); });

describe('excluirOrcamento', () => {
  it('apagou 1 linha: resolve', async () => {
    h.resp = { data: [{ id: 'q1' }], error: null };
    await expect(excluirOrcamento('q1')).resolves.toBeUndefined();
    expect(h.eq).toHaveBeenCalledWith('id', 'q1');
    expect(h.select).toHaveBeenCalledWith('id');
  });

  it('RLS barrou (0 linhas — ex.: envio ao Omie em curso): RECUSA, nunca "excluído"', async () => {
    h.resp = { data: [], error: null };
    await expect(excluirOrcamento('q1')).rejects.toThrow('sendo enviado ao Omie');
  });

  it('erro do PostgREST: propaga', async () => {
    h.resp = { data: null, error: { message: 'rls' } };
    await expect(excluirOrcamento('q1')).rejects.toEqual({ message: 'rls' });
  });
});
