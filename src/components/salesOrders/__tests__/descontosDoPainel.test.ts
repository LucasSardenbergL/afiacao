import { describe, it, expect } from 'vitest';
import { descontosDoPainel } from '../descontosDoPainel';
import type { LinhaDescontoItem } from '@/components/sales/print/descontoCupom';

// Linhas reais de order_items do pedido oben 12183048572 — as mesmas do teste da régua do cupom.
const LINHAS: LinhaDescontoItem[] = [
  { omie_codigo_produto: 8689787325, quantity: 2, unit_price: 584.5, desconto_valor: 116.9 },
  { omie_codigo_produto: 8689791246, quantity: 1, unit_price: 460.25, desconto_valor: 23.01 },
];
const VENDA = { id: 'p1', _source: 'sales' as const };
const AFIACAO = { id: 'a1', _source: 'afiacao' as const };
const LIDA = { estado: 'lida', linhas: LINHAS };
const FALHOU = { estado: 'falhou' };

describe('descontosDoPainel — o que o painel sabe do desconto dos itens', () => {
  it('leitura boa: as linhas do pedido vão para a régua, sem aviso', () => {
    expect(descontosDoPainel(VENDA, { status: 'success', fetchStatus: 'idle', data: { p1: LINHAS } })).toEqual({
      leitura: LIDA,
      falha: null,
    });
  });

  it('pedido sem order_items (push do app) é leitura VAZIA: "não há", porque se leu', () => {
    expect(descontosDoPainel(VENDA, { status: 'success', fetchStatus: 'idle', data: { p1: [] } })).toEqual({
      leitura: { estado: 'lida', linhas: [] },
      falha: null,
    });
  });

  it('refetch que falhou com cache em mãos: a régua usa o cache e a tela avisa erro', () => {
    expect(descontosDoPainel(VENDA, { status: 'error', fetchStatus: 'idle', data: { p1: LINHAS } })).toEqual({
      leitura: LIDA,
      falha: 'erro',
    });
  });

  it('refetch parado sem rede com cache em mãos: a régua usa o cache e a tela avisa sem-rede', () => {
    expect(descontosDoPainel(VENDA, { status: 'success', fetchStatus: 'paused', data: { p1: LINHAS } })).toEqual({
      leitura: LIDA,
      falha: 'sem-rede',
    });
  });

  it('dado que não cobre ESTE pedido não vira "sem desconto": falhou, com aviso de erro', () => {
    expect(descontosDoPainel(VENDA, { status: 'success', fetchStatus: 'idle', data: { outro: [] } })).toEqual({
      leitura: FALHOU,
      falha: 'erro',
    });
  });

  it('1ª leitura falhou: falhou, com aviso de erro', () => {
    expect(descontosDoPainel(VENDA, { status: 'error', fetchStatus: 'idle', data: undefined })).toEqual({
      leitura: FALHOU,
      falha: 'erro',
    });
  });

  it('1ª leitura sem rede (pending + paused): falhou, com aviso de sem-rede', () => {
    expect(descontosDoPainel(VENDA, { status: 'pending', fetchStatus: 'paused', data: undefined })).toEqual({
      leitura: FALHOU,
      falha: 'sem-rede',
    });
  });

  it('carregando: a régua não afirma nada (falhou) e a tela não avisa — é transitório', () => {
    expect(descontosDoPainel(VENDA, { status: 'pending', fetchStatus: 'fetching', data: undefined })).toEqual({
      leitura: FALHOU,
      falha: null,
    });
  });

  it('pergunta não feita (query desabilitada): falhou e sem aviso — não há alarme a fabricar', () => {
    expect(descontosDoPainel(VENDA, { status: 'pending', fetchStatus: 'idle', data: undefined })).toEqual({
      leitura: FALHOU,
      falha: null,
    });
  });

  it('afiação não tem order_items: não se aplica e não avisa, nem com a query em erro', () => {
    expect(descontosDoPainel(AFIACAO, { status: 'error', fetchStatus: 'idle', data: undefined })).toEqual({
      leitura: { estado: 'nao-se-aplica' },
      falha: null,
    });
  });

  it('pedido sem `_source` é de venda, como no resto do painel (só afiação fica de fora)', () => {
    expect(descontosDoPainel({ id: 'p1' }, { status: 'success', fetchStatus: 'idle', data: { p1: LINHAS } })).toEqual({
      leitura: LIDA,
      falha: null,
    });
  });
});
