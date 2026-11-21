import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ edge: { data: null as unknown, error: null as unknown }, invoke: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (...a: unknown[]) => { h.from(...a); throw new Error('DELETE direto não existe mais'); },
    functions: { invoke: (...a: unknown[]) => { h.invoke(...a); return Promise.resolve(h.edge); } },
  },
}));

import { excluirOrcamento } from '../excluir-orcamento';

beforeEach(() => { h.invoke.mockReset(); h.from.mockReset(); h.edge = { data: { success: true }, error: null }; });

describe('excluirOrcamento', () => {
  it('vai SEMPRE pela edge, com a intenção de orçamento — nunca DELETE direto', async () => {
    await expect(excluirOrcamento('q1')).resolves.toBeUndefined();
    expect(h.invoke).toHaveBeenCalledWith('omie-vendas-sync', {
      body: { action: 'excluir_pedido', sales_order_id: 'q1', omie_pedido_id: null, somente_orcamento: true },
    });
    expect(h.from).not.toHaveBeenCalled();
  });

  it('a edge recusa com HTTP 500: o motivo vem do CORPO (error.context), não da mensagem genérica do SDK', async () => {
    const corpo = new Response(JSON.stringify({ error: 'Exclusão recusada: o pedido existe no Omie (PV 9).' }), { status: 500 });
    h.edge = { data: null, error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: corpo }) };
    await expect(excluirOrcamento('q1')).rejects.toThrow('o pedido existe no Omie (PV 9)');
  });

  it('erro sem corpo legível: cai na mensagem do SDK (nunca resolve)', async () => {
    h.edge = { data: null, error: new Error('falha de rede') };
    await expect(excluirOrcamento('q1')).rejects.toThrow('falha de rede');
  });
});
