import { describe, it, expect } from 'vitest';
import {
  leituraDoPedido,
  mensagemAvisoDesconto,
  resolverDescontoCupom,
  type LinhaDescontoItem,
} from '../descontoCupom';

// Pedido real oben 12183048572 (psql-ro, 2026-09-14): o jsonb `sales_orders.items` e as duas linhas
// de `order_items`. As linhas vêm em OUTRA ordem (por omie_codigo_item) — o casamento é por chave
// (produto, quantidade, preço), a mesma identidade da trigger de coerência do agregado.
const ITENS_REAIS = [
  { descricao: 'BASE BRIL 20 FOSCO METALIZADA INTER WJOI.7666GL', quantidade: 1, valor_unitario: 460.25, omie_codigo_produto: 8689791246 },
  { descricao: 'BASE BRIL 20 FOSCO BRANC WJOB.7585GL', quantidade: 2, valor_unitario: 584.5, omie_codigo_produto: 8689787325 },
];
const LINHAS_REAIS: LinhaDescontoItem[] = [
  { omie_codigo_produto: 8689787325, quantity: 2, unit_price: 584.5, desconto_valor: 116.9 },
  { omie_codigo_produto: 8689791246, quantity: 1, unit_price: 460.25, desconto_valor: 23.01 },
];
const lida = (linhas: LinhaDescontoItem[]) => ({ estado: 'lida' as const, linhas });
const item = (prod: number, quantidade: number, valor_unitario: number | null) => ({ omie_codigo_produto: prod, quantidade, valor_unitario });
const linha = (prod: number, quantity: number, unit_price: number | null, desconto_valor: number | null): LinhaDescontoItem =>
  ({ omie_codigo_produto: prod, quantity, unit_price, desconto_valor });

describe('resolverDescontoCupom — quando a quebra de desconto vai para o papel', () => {
  it('quebra quando Subtotal − Desconto fecha com o TOTAL gravado (cabeçalho líquido do #2469)', () => {
    expect(resolverDescontoCupom(ITENS_REAIS, lida(LINHAS_REAIS), 1489.34)).toEqual({
      quebra: true,
      descontoPorItem: [23.01, 116.9],
      subtotalBruto: 1629.25,
      descontoTotal: 139.91,
      itensApurados: 2,
    });
  });

  it('cabeçalho ainda BRUTO (prod hoje, deploy do #2469 pendente): sem quebra, e o aviso diz os dois valores', () => {
    const r = resolverDescontoCupom(ITENS_REAIS, lida(LINHAS_REAIS), 1629.25);
    expect(r.quebra).toBe(false);
    if (r.quebra) return;
    expect(r.aviso).toMatch(/139,91/);
    expect(r.aviso).toMatch(/1\.629,25/);
  });

  it('desconto pequeno em pedido LONGO com cabeçalho bruto não fecha — a conferência é em centavos, não com folga por linha', () => {
    // 40 linhas de R$ 10,00 e R$ 0,15 de desconto. Uma folga de ½ centavo POR LINHA (R$ 0,20) aceitaria
    // o cabeçalho bruto e imprimiria "Subtotal 400,00 / Desconto −0,15 / TOTAL 400,00".
    const itens = Array.from({ length: 40 }, (_, i) => item(1000 + i, 1, 10));
    const linhas = itens.map((it, i) => linha(it.omie_codigo_produto, 1, 10, i === 0 ? 0.15 : 0));
    expect(resolverDescontoCupom(itens, lida(linhas), 400).quebra).toBe(false);
    expect(resolverDescontoCupom(itens, lida(linhas), 399.85).quebra).toBe(true);
  });

  it('nenhuma linha apurada (desconto_valor NULL em todas): como hoje, sem aviso', () => {
    const linhas = LINHAS_REAIS.map((l) => ({ ...l, desconto_valor: null }));
    expect(resolverDescontoCupom(ITENS_REAIS, lida(linhas), 1629.25)).toEqual({ quebra: false, aviso: null });
  });

  it('pedido sem linhas em order_items (push do app): como hoje, sem aviso', () => {
    expect(resolverDescontoCupom(ITENS_REAIS, lida([]), 1629.25)).toEqual({ quebra: false, aviso: null });
  });

  it('desconto ZERO apurado em todas as linhas: como hoje, sem aviso (não há o que explicar)', () => {
    const linhas = LINHAS_REAIS.map((l) => ({ ...l, desconto_valor: 0 }));
    expect(resolverDescontoCupom(ITENS_REAIS, lida(linhas), 1629.25)).toEqual({ quebra: false, aviso: null });
  });

  it('pedido de afiação (sem order_items): como hoje, sem aviso', () => {
    expect(resolverDescontoCupom(ITENS_REAIS, { estado: 'nao-se-aplica' }, 1629.25)).toEqual({ quebra: false, aviso: null });
  });

  it('leitura de order_items FALHOU: como hoje, mas avisa — "não consegui" não é "não há desconto"', () => {
    const r = resolverDescontoCupom(ITENS_REAIS, { estado: 'falhou' }, 1489.34);
    expect(r.quebra).toBe(false);
    if (r.quebra) return;
    expect(r.aviso).toMatch(/não foi possível ler o desconto/);
  });

  it('linha NÃO apurada entre apuradas fica null (vira "—"), nunca 0', () => {
    const itens = [item(1, 1, 100), item(2, 1, 50), item(3, 2, 25)];
    const linhas = [linha(1, 1, 100, 10), linha(2, 1, 50, null), linha(3, 2, 25, 0)];
    expect(resolverDescontoCupom(itens, lida(linhas), 190)).toEqual({
      quebra: true,
      descontoPorItem: [10, null, 0],
      subtotalBruto: 200,
      descontoTotal: 10,
      itensApurados: 2,
    });
  });

  it('mesma chave com descontos DIFERENTES é ambígua: nenhuma das duas recebe desconto e o cupom avisa', () => {
    // Duas bases iguais (cores diferentes no jsonb) com o mesmo produto, quantidade e preço.
    const itens = [item(7, 1, 100), item(7, 1, 100)];
    const linhas = [linha(7, 1, 100, 10), linha(7, 1, 100, 20)];
    const r = resolverDescontoCupom(itens, lida(linhas), 170);
    expect(r.quebra).toBe(false);
    if (r.quebra) return;
    expect(r.aviso).not.toBeNull();
  });

  it('mesma chave com o MESMO desconto casa as duas linhas', () => {
    const itens = [item(7, 1, 100), item(7, 1, 100)];
    const linhas = [linha(7, 1, 100, 10), linha(7, 1, 100, 10)];
    const r = resolverDescontoCupom(itens, lida(linhas), 180);
    expect(r).toMatchObject({ quebra: true, descontoPorItem: [10, 10], descontoTotal: 20 });
  });

  it('linhas iguais com descontos diferentes não herdam desconto nem quando os totais batem por compensação', () => {
    // Sem a regra de ambiguidade, as duas linhas do produto 7 levariam R$ 20 cada (o da 1ª do grupo):
    // Σ 40 = o desconto apurado (20 + 10 + 10 de uma linha sem par) e a conta FECHARIA — com
    // descontos por item inventados no papel.
    const itens = [item(7, 1, 100), item(7, 1, 100)];
    const linhas = [linha(7, 1, 100, 20), linha(7, 1, 100, 10), linha(999, 1, 10, 10)];
    expect(resolverDescontoCupom(itens, lida(linhas), 160).quebra).toBe(false);
  });

  it('item a mais no jsonb que linhas iguais em order_items: o excedente fica "—", não reusa o desconto', () => {
    const itens = [item(7, 1, 100), item(7, 1, 100)];
    const linhas = [linha(7, 1, 100, 10)];
    expect(resolverDescontoCupom(itens, lida(linhas), 190)).toMatchObject({
      quebra: true,
      descontoPorItem: [10, null],
      itensApurados: 1,
    });
  });

  it('a conferência ARREDONDA ao centavo — 0,29 em ponto flutuante é 28,999…, não 28 centavos', () => {
    const itens = [item(1, 1, 1)];
    const linhas = [linha(1, 1, 1, 0.71)];
    expect(resolverDescontoCupom(itens, lida(linhas), 0.29)).toMatchObject({ quebra: true, descontoTotal: 0.71 });
  });

  it('item sem preço impede conferir o total: sem quebra, com aviso', () => {
    const itens = [item(1, 1, 100), item(2, 1, null)];
    const linhas = [linha(1, 1, 100, 10), linha(2, 1, null, 0)];
    const r = resolverDescontoCupom(itens, lida(linhas), 90);
    expect(r.quebra).toBe(false);
    if (r.quebra) return;
    expect(r.aviso).not.toBeNull();
  });

  it('desconto em linha de order_items sem par no cupom não some em silêncio: sem quebra, com aviso', () => {
    const itens = [item(1, 1, 100)];
    const linhas = [linha(1, 1, 100, 0), linha(999, 1, 50, 5)];
    const r = resolverDescontoCupom(itens, lida(linhas), 100);
    expect(r.quebra).toBe(false);
    if (r.quebra) return;
    expect(r.aviso).not.toBeNull();
  });

  it('desconto_valor inválido (negativo) conta como NÃO apurado, não como número', () => {
    const itens = [item(1, 1, 100), item(2, 1, 50)];
    const linhas = [linha(1, 1, 100, 10), linha(2, 1, 50, -5)];
    expect(resolverDescontoCupom(itens, lida(linhas), 140)).toMatchObject({ quebra: true, descontoPorItem: [10, null] });
  });

  it('total gravado ausente não se confere: sem quebra, com aviso', () => {
    const r = resolverDescontoCupom(ITENS_REAIS, lida(LINHAS_REAIS), undefined);
    expect(r.quebra).toBe(false);
    if (r.quebra) return;
    expect(r.aviso).not.toBeNull();
    // Nem quando a conta daria ZERO (desconto de 100%): total ausente não é total zero.
    expect(resolverDescontoCupom([item(1, 1, 10)], lida([linha(1, 1, 10, 10)]), undefined).quebra).toBe(false);
  });
});

describe('leituraDoPedido — o pedido que a leitura em lote não cobriu não vira "sem desconto"', () => {
  it('lote ainda não lido (ou que falhou) → falhou', () => {
    expect(leituraDoPedido(undefined, 'p1')).toEqual({ estado: 'falhou' });
  });

  it('pedido presente no lote → lida, mesmo sem linhas', () => {
    expect(leituraDoPedido({ p1: LINHAS_REAIS, p2: [] }, 'p1')).toEqual({ estado: 'lida', linhas: LINHAS_REAIS });
    expect(leituraDoPedido({ p1: LINHAS_REAIS, p2: [] }, 'p2')).toEqual({ estado: 'lida', linhas: [] });
  });

  it('pedido fora do lote → falhou, nunca lida vazia', () => {
    expect(leituraDoPedido({ p1: LINHAS_REAIS }, 'p3')).toEqual({ estado: 'falhou' });
  });
});

describe('mensagemAvisoDesconto — o toast da equipe quando o cupom sai sem a quebra', () => {
  it('sem aviso nenhum, não há toast', () => {
    expect(mensagemAvisoDesconto([])).toBeNull();
    expect(mensagemAvisoDesconto([undefined, null])).toBeNull();
  });

  it('um cupom: título no singular e o aviso inteiro na descrição', () => {
    expect(mensagemAvisoDesconto([undefined, 'Pedido 12780: não fecha'])).toEqual({
      titulo: 'Cupom impresso sem a coluna de desconto',
      descricao: 'Pedido 12780: não fecha',
    });
  });

  it('lote: conta os cupons e corta a descrição em 5 avisos', () => {
    const avisos = Array.from({ length: 7 }, (_, i) => `Pedido ${i + 1}: não fecha`);
    const mensagem = mensagemAvisoDesconto(avisos);
    expect(mensagem?.titulo).toBe('7 cupons impressos sem a coluna de desconto');
    expect(mensagem?.descricao.split('\n')).toEqual([...avisos.slice(0, 5), '… e mais 2']);
  });
});
