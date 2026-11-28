// PR 3.1 do Novo Pedido ("IA honesta"): o desfecho por item, a soma só na linha SEM cor e a base
// tintométrica pela fila de cor.
import { describe, it, expect } from 'vitest';
import {
  aplicarAdicaoIA,
  contarRelatorio,
  planejarAdicaoIA,
  relatorioTudoDescartado,
} from '../adicao-ia';
import type { CartItem, Product, ProductCartItem, UserTool } from '../types';
import type { AIOrderResult } from '@/components/unifiedAI/types';

const produto = (id: string, extra: Partial<Product> = {}): Product => ({
  id, codigo: `C-${id}`, descricao: `Produto ${id}`, unidade: 'UN', valor_unitario: 10,
  estoque: 5, ativo: true, omie_codigo_produto: 1, account: 'oben', ...extra,
});

const THINNER = produto('thinner');
const BASE = produto('base', { is_tintometric: true, tint_type: 'base' });
const catalogo = [THINNER, BASE];

const nascer = (p: Product, q: number): ProductCartItem =>
  ({ type: 'product', product: p, quantity: q, unit_price: 10, account: 'oben', precoNascimento: 10 });

const ferramenta = { id: 'tool-1', tool_category_id: 'cat', generated_name: 'Serra 300', custom_name: null, quantity: 1 } as unknown as UserTool;

const planejar = (carrinho: CartItem[], resultado: AIOrderResult) =>
  planejarAdicaoIA({ carrinho, resultado, catalogo, userTools: [ferramenta], servicos: [], nascer });

const ia = (product_id: string, quantity = 2, quantidade_inferida = false) =>
  ({ product_id, codigo: '', descricao: `IA ${product_id}`, quantity, quantidade_inferida, account: 'oben' as const });

describe('planejarAdicaoIA — desfecho por item', () => {
  it('produto fora do catálogo NÃO entra e diz por quê (o anúncio não pode contá-lo)', () => {
    const plano = planejar([], { products: [ia('thinner'), ia('fantasma')], services: [] });
    expect(plano.relatorio.itens.map(i => i.desfecho)).toEqual(['adicionado', 'descartado']);
    expect(plano.relatorio.itens[1].motivo).toContain('catálogo');
    expect(contarRelatorio(plano.relatorio)).toMatchObject({ entrou: 1, descartado: 1 });
  });

  it('a soma cai SÓ na linha sem cor — a linha de outra cor do mesmo produto fica intacta', () => {
    const comCor: ProductCartItem = { ...nascer(THINNER, 1), tint_formula_id: 'f-1', tint_nome_cor: 'Azul' };
    const semCor: ProductCartItem = nascer(THINNER, 3);
    const plano = planejar([comCor, semCor], { products: [ia('thinner', 2)], services: [] });
    expect(plano.relatorio.itens[0].desfecho).toBe('somado');
    const depois = aplicarAdicaoIA([comCor, semCor], plano) as ProductCartItem[];
    expect(depois.map(c => c.quantity)).toEqual([1, 5]);
  });

  it('só há linha COM cor: o produto nasce numa linha nova, não soma na cor', () => {
    const comCor: ProductCartItem = { ...nascer(THINNER, 1), tint_formula_id: 'f-1' };
    const plano = planejar([comCor], { products: [ia('thinner', 2)], services: [] });
    expect(plano.relatorio.itens[0].desfecho).toBe('adicionado');
    const depois = aplicarAdicaoIA([comCor], plano) as ProductCartItem[];
    expect(depois.map(c => [c.quantity, c.tint_formula_id ?? null])).toEqual([[1, 'f-1'], [2, null]]);
  });

  it('base tintométrica vai para a fila de cor, nunca direto no carrinho', () => {
    const plano = planejar([], { products: [ia('base', 4)], services: [] });
    expect(plano.novas).toEqual([]);
    expect(plano.relatorio.tintas).toEqual([{ product: BASE, nomeCor: null, quantidade: 4 }]);
    expect(plano.relatorio.itens[0].desfecho).toBe('cor');
  });

  it('o mesmo produto duas vezes na análise vira UMA linha somada', () => {
    const plano = planejar([], { products: [ia('thinner', 2), ia('thinner', 3)], services: [] });
    expect(plano.novas).toHaveLength(1);
    expect((plano.novas[0] as ProductCartItem).quantity).toBe(5);
  });

  it('a decisão é aplicada sobre o carrinho ATUAL (prev), não sobre o do render', () => {
    const plano = planejar([nascer(THINNER, 1)], { products: [ia('thinner', 2)], services: [] });
    const prevMaisNovo = [nascer(THINNER, 7)];
    expect((aplicarAdicaoIA(prevMaisNovo, plano)[0] as ProductCartItem).quantity).toBe(9);
  });

  it('serviço: ferramenta fora do cliente e ferramenta já no pedido são descartadas com motivo', () => {
    const svc = (userToolId: string) => ({ userToolId, omie_codigo_servico: 9, servico_descricao: 'Afiar', quantity: 1, quantidade_inferida: false });
    const noPedido: CartItem = { type: 'service', userTool: ferramenta, servico: null, quantity: 1, photos: [] };
    const plano = planejar([noPedido], { products: [], services: [svc('tool-1'), svc('outra')] });
    expect(plano.relatorio.itens.map(i => [i.desfecho, i.motivo])).toEqual([
      ['descartado', 'esta ferramenta já está no pedido'],
      ['descartado', 'a ferramenta não está carregada para este cliente'],
    ]);
    expect(plano.novas).toEqual([]);
  });

  it('a marca de quantidade inferida chega ao relatório; ausente conta como inferida', () => {
    const semMarca = { product_id: 'thinner', codigo: '', descricao: 'x', quantity: 1, account: 'oben' as const };
    const plano = planejar([], { products: [semMarca], services: [] });
    expect(plano.relatorio.itens[0].quantidadeInferida).toBe(true);
    expect(contarRelatorio(plano.relatorio).inferidas).toBe(1);
  });
});

describe('relatorioTudoDescartado', () => {
  it('carrinho travado: nada entra e todo item leva o motivo', () => {
    const rel = relatorioTudoDescartado({ products: [ia('thinner')], services: [] }, 'pedido sendo enviado');
    expect(contarRelatorio(rel)).toMatchObject({ entrou: 0, descartado: 1 });
    expect(rel.itens[0].motivo).toBe('pedido sendo enviado');
  });
});
