// Revisão /sales, leva 3: #22 (o contato não derruba o detalhe, e é lido UMA vez) e #40 ("não existe"
// tipado, separado de "falhou").
import { describe, it, expect, vi, beforeEach } from 'vitest';

const estado = vi.hoisted(() => ({
  linha: null as Record<string, unknown> | null,
  contato: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (tabela: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => {
        if (tabela === 'sales_orders') return { data: estado.linha, error: null };
        if (tabela === 'profiles') return { data: { name: 'ACME' }, error: null };
        return { data: null, error: null };
      },
    };
    return b;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: async () => ({ data: [], error: null }),
    },
  };
});
vi.mock('@/lib/contato-cliente', () => ({
  lerContatoOperacional: estado.contato,
  lerPerfilContato: vi.fn(async () => null),
}));

import { fetchOrderDetail, PedidoNaoEncontrado } from '../useSalesOrderDetail';

const LINHA = {
  id: 'p1', customer_user_id: 'u1', items: [{ descricao: 'Verniz', quantidade: 1, valor_unitario: 10 }],
  subtotal: 10, discount: 0, total: 10, status: 'rascunho', notes: 'obs', account: 'oben',
  omie_pedido_id: null, omie_numero_pedido: null, created_at: '2026-11-20T10:00:00Z',
};

beforeEach(() => {
  estado.linha = { ...LINHA };
  estado.contato.mockReset();
});

describe('fetchOrderDetail', () => {
  it('#22: contato que FALHA (a lente barra a RPC operacional) não derruba itens e notas', async () => {
    estado.contato.mockRejectedValue(Object.assign(new Error('x'), { name: 'LensReadOnlyError' }));
    const d = await fetchOrderDetail('sales', 'p1', 'ACME', true);
    expect(d.order.items).toHaveLength(1);
    expect(d.order.notes).toBe('obs');
    expect(d.contatoIndisponivel).toBe(true);
    expect(d.customerDocument).toBeUndefined();
    expect(d.order.customer_address ?? null).toBeNull();
  });

  it('#22: o contato do pedido comercial é lido UMA vez (endereço, telefone e documento juntos)', async () => {
    estado.contato.mockResolvedValue(new Map([['p1', {
      pedido_endereco: 'Rua A, 1', pedido_telefone: '4899', document: '123',
    }]]));
    const d = await fetchOrderDetail('sales', 'p1', 'ACME', true);
    expect(estado.contato).toHaveBeenCalledTimes(1);
    expect(d.order.customer_address).toBe('Rua A, 1');
    expect(d.order.customer_phone).toBe('4899');
    expect(d.customerDocument).toBe('123');
    expect(d.contatoIndisponivel).toBeUndefined();
  });

  it('#40: pedido que não existe lança PedidoNaoEncontrado (não é falha de leitura)', async () => {
    estado.linha = null;
    await expect(fetchOrderDetail('sales', 'p1', 'ACME', true)).rejects.toBeInstanceOf(PedidoNaoEncontrado);
  });
});
