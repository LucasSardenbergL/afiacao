import { describe, it, expect } from 'vitest';
import { montarCompartilhamento } from '../compartilhar';
import type { LeituraDescontosItens, LinhaDescontoItem } from '@/components/sales/print/descontoCupom';
import type { SalesOrder } from '../types';

// Pedido real oben 12183048572 (1 × 460,25 com R$ 23,01; 2 × 584,50 com R$ 116,90) — as mesmas linhas
// do teste da régua do cupom. O jsonb traz o produto do Omie, que a régua usa para casar a linha.
const ITENS = [
  { descricao: 'BASE METALIZADA', quantidade: 1, valor_unitario: 460.25, valor_total: 460.25, omie_codigo_produto: 8689791246 },
  { descricao: 'BASE BRANCA', quantidade: 2, valor_unitario: 584.5, valor_total: 1169, omie_codigo_produto: 8689787325 },
] as unknown as SalesOrder['items'];
const LINHAS: LinhaDescontoItem[] = [
  { omie_codigo_produto: 8689787325, quantity: 2, unit_price: 584.5, desconto_valor: 116.9 },
  { omie_codigo_produto: 8689791246, quantity: 1, unit_price: 460.25, desconto_valor: 23.01 },
];
const lida = (linhas: LinhaDescontoItem[]): LeituraDescontosItens => ({ estado: 'lida', linhas });
const pedido = (total: number) => ({ items: ITENS, total });

// A mensagem de sempre: descrição, quantidade e preço do jsonb, SEM a chave `lineTotal` (o share faz
// quantidade × preço) e sem `quebraDesconto`. `toStrictEqual` reprova a chave presente com undefined.
const ITENS_COMO_HOJE = [
  { description: 'BASE METALIZADA', quantity: 1, unitPrice: 460.25 },
  { description: 'BASE BRANCA', quantity: 2, unitPrice: 584.5 },
];
const TITULO_AVISO = 'Mensagem do WhatsApp sem as linhas de desconto';

describe('montarCompartilhamento — a régua do cupom na mensagem de WhatsApp', () => {
  it('cabeçalho líquido que fecha: cada linha vai LÍQUIDA e a quebra acompanha, sem aviso', () => {
    expect(montarCompartilhamento(pedido(1489.34), lida(LINHAS))).toStrictEqual({
      items: [
        { description: 'BASE METALIZADA', quantity: 1, unitPrice: 460.25, lineTotal: 437.24 },
        { description: 'BASE BRANCA', quantity: 2, unitPrice: 584.5, lineTotal: 1052.1 },
      ],
      quebraDesconto: { subtotalBruto: 1629.25, descontoTotal: 139.91, itensApurados: 2 },
      aviso: null,
    });
  });

  it('linha não apurada entre apuradas: o líquido dela é null (sai "—"), nunca o bruto', () => {
    const linhas = LINHAS.map((l) => (l.omie_codigo_produto === 8689787325 ? { ...l, desconto_valor: null } : l));
    expect(montarCompartilhamento(pedido(1606.24), lida(linhas))).toStrictEqual({
      items: [
        { description: 'BASE METALIZADA', quantity: 1, unitPrice: 460.25, lineTotal: 437.24 },
        { description: 'BASE BRANCA', quantity: 2, unitPrice: 584.5, lineTotal: null },
      ],
      quebraDesconto: { subtotalBruto: 1629.25, descontoTotal: 23.01, itensApurados: 1 },
      aviso: null,
    });
  });

  it('cabeçalho ainda BRUTO (prod hoje): a mensagem de sempre, e o aviso da equipe traz os dois valores', () => {
    const r = montarCompartilhamento(pedido(1629.25), lida(LINHAS));
    expect(r.items).toStrictEqual(ITENS_COMO_HOJE);
    expect(r).not.toHaveProperty('quebraDesconto');
    expect(r.aviso?.titulo).toBe(TITULO_AVISO);
    expect(r.aviso?.descricao).toMatch(
      /^o desconto apurado dos itens \(R\$\s139,91\) não fecha com o total gravado \(R\$\s1\.629,25\) — a mensagem saiu sem as linhas de desconto\.$/,
    );
  });

  it('leitura de order_items FALHOU: a mensagem de sempre, e o aviso diz que não conseguiu ler', () => {
    const r = montarCompartilhamento(pedido(1489.34), { estado: 'falhou' });
    expect(r.items).toStrictEqual(ITENS_COMO_HOJE);
    expect(r).not.toHaveProperty('quebraDesconto');
    expect(r.aviso).toStrictEqual({
      titulo: TITULO_AVISO,
      descricao: 'não foi possível ler o desconto dos itens — a mensagem saiu sem as linhas de desconto. Tente compartilhar de novo.',
    });
  });

  it('o aviso fala da MENSAGEM: nunca do cupom, nunca "sem desconto"', () => {
    const casos: Array<[number, LeituraDescontosItens]> = [
      [1629.25, lida(LINHAS)],
      [1489.34, { estado: 'falhou' }],
    ];
    for (const [total, leitura] of casos) {
      const { aviso } = montarCompartilhamento(pedido(total), leitura);
      expect(aviso).not.toBeNull();
      expect(`${aviso?.titulo} ${aviso?.descricao}`).not.toMatch(/cupom|sem desconto/);
    }
  });

  it('sem desconto a explicar (afiação, sem order_items, nada apurado, desconto zero): a mensagem de sempre, sem aviso', () => {
    const leituras: LeituraDescontosItens[] = [
      { estado: 'nao-se-aplica' },
      lida([]),
      lida(LINHAS.map((l) => ({ ...l, desconto_valor: null }))),
      lida(LINHAS.map((l) => ({ ...l, desconto_valor: 0 }))),
    ];
    for (const leitura of leituras) {
      expect(montarCompartilhamento(pedido(1629.25), leitura)).toStrictEqual({ items: ITENS_COMO_HOJE, aviso: null });
    }
  });

  it('preço não sabido segue null até a mensagem — nunca vira R$ 0,00', () => {
    const itens = [{ descricao: 'BASE SEM PREÇO', quantidade: 3, valor_unitario: null, valor_total: null }] as unknown as SalesOrder['items'];
    expect(montarCompartilhamento({ items: itens, total: 0 }, { estado: 'nao-se-aplica' }).items).toStrictEqual([
      { description: 'BASE SEM PREÇO', quantity: 3, unitPrice: null },
    ]);
  });

  it('pedido sem itens no jsonb (null): lista vazia, sem quebrar', () => {
    expect(montarCompartilhamento({ items: null, total: 0 }, { estado: 'nao-se-aplica' })).toStrictEqual({ items: [], aviso: null });
  });
});
