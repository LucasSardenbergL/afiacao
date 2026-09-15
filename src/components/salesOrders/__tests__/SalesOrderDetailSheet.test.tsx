import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SalesOrderDetailSheet } from '../SalesOrderDetailSheet';
import type { SalesOrder } from '../types';
import type { FatiaDescontosItens } from '../descontosDoPainel';
import type { LinhaDescontoItem } from '@/components/sales/print/descontoCupom';

function order(p: Partial<SalesOrder> = {}): SalesOrder {
  return {
    id: 'o1',
    customer_user_id: 'u1',
    items: [
      // Base com tinta + valor_total zerado (caso do rascunho da foto)
      { descricao: 'BASE PU ACRI FOSCO', quantidade: 2, valor_unitario: 50, valor_total: 0, tint_cor_id: '1247', tint_nome_cor: 'AZUL RAL 5010' },
      { descricao: 'CATALISADOR FC', quantidade: 2, valor_unitario: 40, valor_total: 80 },
    ],
    subtotal: 180,
    total: 180,
    status: 'rascunho',
    omie_numero_pedido: '0011326',
    omie_pedido_id: null,
    created_at: '2026-06-02T21:00:00Z',
    notes: null,
    account: 'oben',
    _source: 'sales',
    ...p,
  } as SalesOrder;
}

// A leitura de order_items respondeu e o pedido não tem linhas: nada a explicar — a tela de sempre.
const SEM_DESCONTO: FatiaDescontosItens = { status: 'success', fetchStatus: 'idle', data: { o1: [] } };

function setup(
  o: SalesOrder | null,
  extra: { open?: boolean; loading?: boolean; descontosItens?: FatiaDescontosItens } = {},
) {
  render(
    <SalesOrderDetailSheet
      open={extra.open ?? !!o}
      loading={extra.loading}
      order={o}
      customerName="DELTA INTERIORES"
      descontosItens={extra.descontosItens ?? SEM_DESCONTO}
      onClose={vi.fn()}
      onPrint={vi.fn()}
      onShare={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

describe('SalesOrderDetailSheet', () => {
  it('mostra a cor da base (código - nome) quando o item tem tinta', () => {
    setup(order());
    expect(screen.getByText(/🎨\s*1247\s*-\s*AZUL RAL 5010/)).toBeTruthy();
  });

  it('cor sem cor_id (vinda do sync do Omie) mostra só o nome, sem hífen órfão', () => {
    setup(order({ items: [{ descricao: 'BASE BRILH BRANC PU', quantidade: 1, valor_unitario: 86, valor_total: 86, tint_nome_cor: 'AZUL RAL 5010' }] }));
    expect(screen.getByText('🎨 AZUL RAL 5010')).toBeTruthy();
  });

  it('item sem tinta não mostra linha de cor', () => {
    setup(order({ items: [{ descricao: 'CATALISADOR', quantidade: 1, valor_unitario: 40, valor_total: 40 }] }));
    expect(screen.queryByText(/🎨/)).toBeNull();
  });

  it('exibe o total do item calculado (qtd × unit) quando valor_total vem 0', () => {
    setup(order());
    // base 2 × R$ 50 → total R$ 100,00 (não R$ 0,00)
    expect(screen.getByText(/R\$\s*100,00/)).toBeTruthy();
  });

  it('order null não renderiza conteúdo (painel fechado)', () => {
    setup(null);
    expect(screen.queryByText('DELTA INTERIORES')).toBeNull();
  });

  it('aberto + carregando (detalhe em voo) mostra spinner, sem conteúdo', () => {
    setup(null, { open: true, loading: true });
    expect(screen.queryByText('DELTA INTERIORES')).toBeNull();
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('aberto + falha do detalhe mostra mensagem honesta', () => {
    setup(null, { open: true, loading: false });
    expect(screen.getByText('Não foi possível carregar o pedido.')).toBeTruthy();
  });

  it('botão Repetir aparece pra pedido comercial e dispara onRepeat', () => {
    const onRepeat = vi.fn();
    render(
      <SalesOrderDetailSheet
        open
        order={order()}
        customerName="DELTA INTERIORES"
        descontosItens={SEM_DESCONTO}
        onClose={vi.fn()} onPrint={vi.fn()} onShare={vi.fn()} onEdit={vi.fn()}
        onRepeat={onRepeat}
      />,
    );
    screen.getByText('Repetir').click();
    expect(onRepeat).toHaveBeenCalledTimes(1);
  });

  it('botão Repetir NÃO aparece pra pedido de afiação (formato de item diferente)', () => {
    render(
      <SalesOrderDetailSheet
        open
        order={order({ _source: 'afiacao' })}
        customerName="DELTA INTERIORES"
        descontosItens={SEM_DESCONTO}
        onClose={vi.fn()} onPrint={vi.fn()} onShare={vi.fn()} onEdit={vi.fn()}
        onRepeat={vi.fn()}
      />,
    );
    expect(screen.queryByText('Repetir')).toBeNull();
  });
});

// ── Desconto dos itens ───────────────────────────────────────────────────────────────────────────
// Pedido real oben 12183048572: 1 × 460,25 com R$ 23,01 de desconto e 2 × 584,50 com R$ 116,90 — as
// linhas do teste da régua do cupom (descontoCupom.test.ts). O jsonb traz o produto do Omie, fora do
// tipo do item, e é por ele (com quantidade e preço) que a régua casa o item com a linha de order_items.
const METALIZADA = 'BASE BRIL 20 FOSCO METALIZADA INTER WJOI.7666GL';
const BRANCA = 'BASE BRIL 20 FOSCO BRANC WJOB.7585GL';
const ITENS_REAIS = [
  { descricao: METALIZADA, quantidade: 1, valor_unitario: 460.25, valor_total: 460.25, omie_codigo_produto: 8689791246 },
  { descricao: BRANCA, quantidade: 2, valor_unitario: 584.5, valor_total: 1169, omie_codigo_produto: 8689787325 },
] as unknown as SalesOrder['items'];
const LINHAS_REAIS: LinhaDescontoItem[] = [
  { omie_codigo_produto: 8689787325, quantity: 2, unit_price: 584.5, desconto_valor: 116.9 },
  { omie_codigo_produto: 8689791246, quantity: 1, unit_price: 460.25, desconto_valor: 23.01 },
];
const trocarDesconto = (produto: number, desconto_valor: number | null) =>
  LINHAS_REAIS.map((l) => (l.omie_codigo_produto === produto ? { ...l, desconto_valor } : l));

/** O pedido real com o cabeçalho (subtotal = total) em `total`: 1.489,34 líquido, 1.629,25 ainda bruto. */
const pedidoReal = (total: number) => order({ id: 'p1', items: ITENS_REAIS, subtotal: total, total });
const lida = (linhas: LinhaDescontoItem[]): FatiaDescontosItens => ({
  status: 'success',
  fetchStatus: 'idle',
  data: { p1: linhas },
});
const ERRO: FatiaDescontosItens = { status: 'error', fetchStatus: 'idle', data: undefined };
const SEM_REDE: FatiaDescontosItens = { status: 'pending', fetchStatus: 'paused', data: undefined };

// O toLocaleString('pt-BR') separa "R$" do número com espaço NÃO separável: compara-se o texto visível.
const texto = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');

/** A sublinha do item (quantidade × preço, e o desconto quando há quebra) e o total da linha. */
function linhaDoItem(descricao: string) {
  const info = screen.getByText(descricao).parentElement!;
  const paragrafos = info.querySelectorAll('p');
  const valor = Array.from(info.parentElement!.children).find((el) => el.tagName === 'SPAN');
  return { sublinha: texto(paragrafos[paragrafos.length - 1]), total: texto(valor) };
}

/** Os totais como a tela os mostra: um par [rótulo, valor] por linha. */
function totais() {
  const bloco = screen.getByText('Total').parentElement!.parentElement!;
  return Array.from(bloco.children).map((linha) => Array.from(linha.children).map((el) => texto(el)));
}

const aviso = () => document.querySelector('[data-testid="aviso-desconto-itens"]');

describe('SalesOrderDetailSheet — desconto dos itens pela régua do cupom', () => {
  it('cabeçalho líquido que fecha: cada linha mostra o desconto e o LÍQUIDO, e os totais explicam a diferença', () => {
    setup(pedidoReal(1489.34), { descontosItens: lida(LINHAS_REAIS) });
    expect(linhaDoItem(METALIZADA)).toEqual({ sublinha: '1 × R$ 460,25 · desconto - R$ 23,01', total: 'R$ 437,24' });
    expect(linhaDoItem(BRANCA)).toEqual({ sublinha: '2 × R$ 584,50 · desconto - R$ 116,90', total: 'R$ 1.052,10' });
    expect(totais()).toEqual([
      ['Subtotal', 'R$ 1.629,25'],
      ['Desconto', '- R$ 139,91'],
      ['Total', 'R$ 1.489,34'],
    ]);
    expect(aviso()).toBeNull();
  });

  it('linha não apurada entre apuradas sai "—", nunca R$ 0,00, e o rótulo diz quantos itens entraram', () => {
    setup(pedidoReal(1512.35), { descontosItens: lida(trocarDesconto(8689791246, null)) });
    expect(linhaDoItem(METALIZADA)).toEqual({ sublinha: '1 × R$ 460,25 · desconto —', total: '—' });
    expect(linhaDoItem(BRANCA)).toEqual({ sublinha: '2 × R$ 584,50 · desconto - R$ 116,90', total: 'R$ 1.052,10' });
    expect(totais()).toEqual([
      ['Subtotal', 'R$ 1.629,25'],
      ['Desconto (1 de 2 itens)', '- R$ 116,90'],
      ['Total', 'R$ 1.512,35'],
    ]);
  });

  it('desconto zero numa linha, dentro de uma quebra, não acrescenta nada: o total dela é o bruto', () => {
    setup(pedidoReal(1606.24), { descontosItens: lida(trocarDesconto(8689787325, 0)) });
    expect(linhaDoItem(BRANCA)).toEqual({ sublinha: '2 × R$ 584,50', total: 'R$ 1.169,00' });
    expect(linhaDoItem(METALIZADA)).toEqual({ sublinha: '1 × R$ 460,25 · desconto - R$ 23,01', total: 'R$ 437,24' });
    expect(totais()).toEqual([
      ['Subtotal', 'R$ 1.629,25'],
      ['Desconto', '- R$ 23,01'],
      ['Total', 'R$ 1.606,24'],
    ]);
  });

  it('cache em mãos e refetch que falhou: a quebra do cache continua na tela, com o aviso', () => {
    setup(pedidoReal(1489.34), { descontosItens: { status: 'error', fetchStatus: 'idle', data: { p1: LINHAS_REAIS } } });
    expect(totais()[1]).toEqual(['Desconto', '- R$ 139,91']);
    expect(aviso()?.getAttribute('data-estado')).toBe('erro');
  });

  it('leitura que FALHOU não vira "sem desconto": os totais de sempre e o aviso de erro', () => {
    setup(pedidoReal(1489.34), { descontosItens: ERRO });
    expect(aviso()?.getAttribute('data-estado')).toBe('erro');
    expect(texto(aviso())).toContain('Não foi possível carregar o desconto dos itens');
    expect(totais()).toEqual([
      ['Subtotal', 'R$ 1.489,34'],
      ['Total', 'R$ 1.489,34'],
    ]);
  });

  it('sem rede: o aviso diz sem-rede', () => {
    setup(pedidoReal(1489.34), { descontosItens: SEM_REDE });
    expect(aviso()?.getAttribute('data-estado')).toBe('sem-rede');
  });

  it('pedido de afiação: sem aviso e sem linha de desconto', () => {
    setup(order({ _source: 'afiacao' }), { descontosItens: { status: 'pending', fetchStatus: 'idle', data: undefined } });
    expect(aviso()).toBeNull();
    expect(screen.queryByText(/^Desconto/)).toBeNull();
  });
});

// "Como hoje" medido na MARCAÇÃO inteira do painel, não numa amostra de texto: sem quebra, o painel é o
// de um pedido cuja leitura respondeu sem desconto a explicar. Os ids do Radix mudam a cada montagem.
function marcacao(o: SalesOrder, descontosItens: FatiaDescontosItens, { tirarAviso = false } = {}) {
  setup(o, { descontosItens });
  if (tirarAviso) {
    const el = aviso();
    expect(el).not.toBeNull();
    el?.remove();
  }
  const painel = document.querySelector('[role="dialog"]');
  expect(painel).not.toBeNull();
  const html = (painel?.outerHTML ?? '').replace(/:r[0-9a-z]+:/g, ':r:');
  cleanup();
  return html;
}

describe('SalesOrderDetailSheet — sem quebra, a tela é a de hoje', () => {
  const hojeLiquido = () => marcacao(pedidoReal(1489.34), lida([]));
  const hojeBruto = () => marcacao(pedidoReal(1629.25), lida([]));

  it.each<[string, () => string, () => string]>([
    ['cabeçalho ainda BRUTO: a conta não fecha', () => marcacao(pedidoReal(1629.25), lida(LINHAS_REAIS)), hojeBruto],
    ['desconto apurado zero', () => marcacao(pedidoReal(1629.25), lida(LINHAS_REAIS.map((l) => ({ ...l, desconto_valor: 0 })))), hojeBruto],
    ['nenhuma linha apurada', () => marcacao(pedidoReal(1629.25), lida(LINHAS_REAIS.map((l) => ({ ...l, desconto_valor: null })))), hojeBruto],
    ['leitura carregando', () => marcacao(pedidoReal(1489.34), { status: 'pending', fetchStatus: 'fetching', data: undefined }), hojeLiquido],
    ['pergunta não feita (query desabilitada)', () => marcacao(pedidoReal(1489.34), { status: 'pending', fetchStatus: 'idle', data: undefined }), hojeLiquido],
  ])('%s', (_nome, cenario, hoje) => {
    expect(cenario()).toBe(hoje());
  });

  it.each<[string, FatiaDescontosItens]>([
    ['erro', ERRO],
    ['sem rede', SEM_REDE],
    ['dado que não cobre o pedido', { status: 'success', fetchStatus: 'idle', data: { outro: LINHAS_REAIS } }],
  ])('leitura sem resposta (%s): a tela de hoje MAIS o aviso, e nada além', (_nome, q) => {
    expect(marcacao(pedidoReal(1489.34), q, { tirarAviso: true })).toBe(hojeLiquido());
  });
});
