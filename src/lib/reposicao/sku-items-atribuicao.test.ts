import { describe, it, expect } from 'vitest';
import {
  resolverPedidoDoItem,
  trackingIdDoItem,
  t4DoRecebimento,
  type PedidoCandidato,
} from '@/lib/reposicao/sku-items-atribuicao';

const pedido = (id: string): PedidoCandidato => ({
  id,
  t1_data_pedido: '2026-01-10T00:00:00-03:00',
  numero_pedido: '123',
  grupo_leadtime: 'TINTA',
  fornecedor_nome: 'FORN',
});

describe('resolverPedidoDoItem', () => {
  it('resolve quando há exatamente 1 candidato', () => {
    expect(resolverPedidoDoItem([pedido('a')])?.id).toBe('a');
  });

  it('AMBÍGUO (>1 candidato) => null: nunca carimba o t1 de um pedido arbitrário', () => {
    // o código antigo usava .limit(1) SEM .order() — escolha não-determinística.
    expect(resolverPedidoDoItem([pedido('a'), pedido('b')])).toBeNull();
  });

  it('sem candidato => null', () => {
    expect(resolverPedidoDoItem([])).toBeNull();
  });
});

describe('trackingIdDoItem', () => {
  it('atribui o item ao PEDIDO dele quando resolvido', () => {
    expect(trackingIdDoItem(pedido('pedido-1'), 'nfe-9')).toBe('pedido-1');
  });

  it('irmãs da MESMA NFe convergem para o mesmo tracking_id (é o que deduplica)', () => {
    // duas linhas irmãs consultam o mesmo recebimento e veem o mesmo item;
    // ambas devem produzir a MESMA chave => o upsert colapsa em 1 linha.
    const p = pedido('pedido-1');
    expect(trackingIdDoItem(p, 'nfe-irma-A')).toBe(trackingIdDoItem(p, 'nfe-irma-B'));
  });

  it('sem pedido resolvido => cai na linha da NFe (comportamento atual preservado)', () => {
    expect(trackingIdDoItem(null, 'nfe-9')).toBe('nfe-9');
  });
});

describe('t4DoRecebimento', () => {
  it('usa a data do PAYLOAD do recebimento (autoritativa), não a da linha que consultou', () => {
    const detalhe = { infoCadastro: { cRecebido: 'S', dRec: '15/01/2026', hRec: '14:30' } };
    expect(t4DoRecebimento(detalhe, '2026-01-20T00:00:00-03:00'))
      .toBe('2026-01-15T14:30:00-03:00');
  });

  it('não recebido => null, NÃO o fallback (ausente ≠ data errada)', () => {
    const detalhe = { infoCadastro: { cRecebido: 'N', dRec: '15/01/2026' } };
    expect(t4DoRecebimento(detalhe, '2026-01-20T00:00:00-03:00')).toBeNull();
  });

  it('payload sem data legível => cai no valor da linha (degrada, não inventa)', () => {
    expect(t4DoRecebimento({ infoCadastro: { cRecebido: 'S' } }, '2026-01-20T00:00:00-03:00'))
      .toBe('2026-01-20T00:00:00-03:00');
  });

  it('payload inutilizável e sem fallback => null', () => {
    expect(t4DoRecebimento(null, null)).toBeNull();
  });

  it('infoCadastro ausente => preserva o fallback (nunca inventa, nunca descarta)', () => {
    const fallback = '2026-01-20T00:00:00-03:00';
    expect(t4DoRecebimento({}, fallback)).toBe(fallback);
  });
});
