import { describe, it, expect, vi } from 'vitest';
import {
  itensNaoVendaveis,
  validarVendabilidade,
  bloqueioVendabilidade,
} from '../vendabilidade';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';
import type { SubmitClient } from '../types';

function item(id: string, codigo = `C${id}`, descricao = `Prod ${id}`): ProductCartItem {
  return {
    type: 'product',
    account: 'oben',
    quantity: 1,
    unit_price: 1,
    product: { id, omie_codigo_produto: 1, codigo, descricao, unidade: 'UN' },
  } as unknown as ProductCartItem;
}

/** Mock mínimo: from('omie_products').select('id, ativo').in('id', ids) → {data,error}. */
function supa(data: unknown, error: unknown = null): SubmitClient {
  const inFn = vi.fn().mockResolvedValue({ data, error });
  const select = vi.fn().mockReturnValue({ in: inFn });
  const from = vi.fn().mockReturnValue({ select });
  return { from } as unknown as SubmitClient;
}

describe('itensNaoVendaveis (puro)', () => {
  it('todos no set de vendáveis → []', () => {
    expect(itensNaoVendaveis([item('a'), item('b')], new Set(['a', 'b']))).toEqual([]);
  });

  it('um fora do set → retorna esse (codigo + descricao)', () => {
    expect(
      itensNaoVendaveis([item('a'), item('b', 'C9', 'Inativo X')], new Set(['a'])),
    ).toEqual([{ codigo: 'C9', descricao: 'Inativo X' }]);
  });

  it('dedupe por id (mesmo produto 2× no carrinho)', () => {
    expect(itensNaoVendaveis([item('z', 'CZ', 'Z'), item('z', 'CZ', 'Z')], new Set())).toEqual([
      { codigo: 'CZ', descricao: 'Z' },
    ]);
  });

  it('id vazio é tratado como NÃO vendável (fail-closed)', () => {
    expect(itensNaoVendaveis([item('')], new Set(['a']))).toHaveLength(1);
  });
});

describe('validarVendabilidade (I/O)', () => {
  it('carrinho sem produtos → ok, sem tocar o banco', async () => {
    const from = vi.fn();
    const r = await validarVendabilidade({ from } as unknown as SubmitClient, []);
    expect(r).toEqual({ status: 'ok' });
    expect(from).not.toHaveBeenCalled();
  });

  it('itens mas TODOS sem product.id → inativos (fail-closed; NÃO cai em ok)', async () => {
    // Regressão: o `.filter(Boolean)` esvaziava `ids` → early-return ok (fail-OPEN).
    const from = vi.fn();
    const r = await validarVendabilidade({ from } as unknown as SubmitClient, [item(''), item('')]);
    expect(r.status).toBe('inativos');
    expect(from).not.toHaveBeenCalled(); // sem id resolvível, nem consulta o banco
  });

  it('todos ativos no banco → ok', async () => {
    const r = await validarVendabilidade(
      supa([{ id: 'a', ativo: true }, { id: 'b', ativo: true }]),
      [item('a'), item('b')],
    );
    expect(r).toEqual({ status: 'ok' });
  });

  it('um inativo no banco → status inativos com o item', async () => {
    const r = await validarVendabilidade(
      supa([{ id: 'a', ativo: true }, { id: 'b', ativo: false }]),
      [item('a'), item('b', 'C9', 'Bloq')],
    );
    expect(r).toEqual({ status: 'inativos', itens: [{ codigo: 'C9', descricao: 'Bloq' }] });
  });

  it('produto AUSENTE do retorno (sumiu do catálogo) → inativos (fail-closed)', async () => {
    const r = await validarVendabilidade(supa([{ id: 'a', ativo: true }]), [
      item('a'),
      item('x', 'CX', 'Sumiu'),
    ]);
    expect(r).toEqual({ status: 'inativos', itens: [{ codigo: 'CX', descricao: 'Sumiu' }] });
  });

  it('erro na query → status erro (fail-closed, não deixa passar)', async () => {
    const r = await validarVendabilidade(supa(null, { message: 'net' }), [item('a')]);
    expect(r.status).toBe('erro');
  });
});

describe('bloqueioVendabilidade', () => {
  it('ok → null (libera o submit)', () => {
    expect(bloqueioVendabilidade({ status: 'ok' })).toBeNull();
  });

  it('erro → a própria mensagem', () => {
    expect(bloqueioVendabilidade({ status: 'erro', message: 'falha temporária' })).toBe(
      'falha temporária',
    );
  });

  it('inativos → mensagem listando código e descrição', () => {
    const msg = bloqueioVendabilidade({
      status: 'inativos',
      itens: [{ codigo: 'C9', descricao: 'Lixa velha' }],
    });
    expect(msg).toContain('C9');
    expect(msg).toContain('Lixa velha');
  });
});
