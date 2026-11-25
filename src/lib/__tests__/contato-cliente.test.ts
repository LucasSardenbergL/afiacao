// Onda D: as duas portas do contato de cliente. O que este teste prende:
//  - a RPC operacional vai em lotes de no máximo 200 (o servidor recusa 201 com 22023);
//  - erro da RPC/view LANÇA (nunca vira "cliente sem contato");
//  - fora da carteira a mescla devolve null + contato_visivel=false (≠ "sem telefone");
//  - endereço principal = o padrão, senão o mais antigo (a mesma ordem da RPC).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const inFn = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (tabela: string) => ({
      select: () => ({ in: (_c: string, ids: string[]) => inFn(tabela, ids) }),
    }),
  },
}));

import {
  comContatoMascarado, enderecoPrincipal, lerContatoOperacional, LOTE_OPERACIONAL, ordenarEnderecos,
} from '@/lib/contato-cliente';

beforeEach(() => { rpc.mockReset(); inFn.mockReset(); });

describe('lerContatoOperacional', () => {
  it('quebra em lotes de no máximo 200 e indexa pelo OBJETO', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `obj-${i}`);
    rpc.mockImplementation(async (_n: string, args: { p_objeto_ids: string[] }) => ({
      data: args.p_objeto_ids.map((o) => ({ objeto_id: o, customer_user_id: `c-${o}`, via_excecao: true, enderecos: null })),
      error: null,
    }));
    const m = await lerContatoOperacional('pedido', [...ids, null, ids[0]], 'impressao_pedido');
    const tamanhos = rpc.mock.calls.map((c) => (c[1] as { p_objeto_ids: string[] }).p_objeto_ids.length);
    expect(Math.max(...tamanhos)).toBeLessThanOrEqual(LOTE_OPERACIONAL);
    expect(tamanhos.reduce((a, b) => a + b, 0)).toBe(450);
    expect(m.get('obj-7')?.customer_user_id).toBe('c-obj-7');
    expect(m.get('obj-7')?.enderecos).toEqual([]);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_objeto_tipo: 'pedido', p_motivo: 'impressao_pedido' });
  });

  it('erro da RPC lança com a mensagem do servidor', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'contato_cliente_operacional: sem permissao', code: '42501' } });
    await expect(lerContatoOperacional('pedido', ['x'], 'detalhe_pedido')).rejects.toMatchObject({ code: '42501' });
  });

  it('lista vazia não chama o servidor', async () => {
    expect((await lerContatoOperacional('rota', [], 'visita_agendada')).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('comContatoMascarado', () => {
  it('fora da carteira = null com contato_visivel false; sem linha = idem', async () => {
    inFn.mockResolvedValue({
      data: [
        { user_id: 'dentro', contato_visivel: true, email: 'a@x', phone: 'f1', document: 'd1', cnpj: null, eh_pj: false },
        { user_id: 'fora', contato_visivel: false, email: null, phone: null, document: null, cnpj: null, eh_pj: true },
      ],
      error: null,
    });
    const r = await comContatoMascarado([{ user_id: 'dentro', name: 'A' }, { user_id: 'fora', name: 'B' }, { user_id: 'alheio', name: 'C' }]);
    expect(inFn).toHaveBeenCalledWith('v_perfil_contato', ['dentro', 'fora', 'alheio']);
    expect(r[0]).toMatchObject({ name: 'A', phone: 'f1', contato_visivel: true });
    expect(r[1]).toMatchObject({ name: 'B', phone: null, contato_visivel: false });
    expect(r[2]).toMatchObject({ name: 'C', phone: null, contato_visivel: false });
  });

  it('erro da view lança', async () => {
    inFn.mockResolvedValue({ data: null, error: { message: 'boom', code: 'XX000' } });
    await expect(comContatoMascarado([{ user_id: 'a' }])).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('endereços', () => {
  it('padrão primeiro, depois o mais antigo, desempate por id', () => {
    const xs = [
      { id: 'b', is_default: false, created_at: '2026-01-01' },
      { id: 'c', is_default: true, created_at: '2026-03-01' },
      { id: 'a', is_default: false, created_at: '2026-01-01' },
    ];
    expect(ordenarEnderecos(xs).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(enderecoPrincipal(xs)?.id).toBe('c');
    expect(enderecoPrincipal([{ id: 'z', is_default: null }])?.id).toBe('z');
    expect(enderecoPrincipal([])).toBeNull();
  });
});
