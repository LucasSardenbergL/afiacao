/**
 * @vitest-environment jsdom
 *
 * `.ts` no ambiente jsdom pelo mesmo motivo de `sales/print/__tests__/buildPrintHtml.test.ts`:
 * `openPrintOrder` escreve o cupom numa janela nova, e o dublê de `window.open` captura o HTML.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openPrintOrder, textoVencimentosDoCupom, type PrintOrderData } from '../OrderPrintLayout';
import { formatPrecoOuAusente as fmt } from '@/lib/format';

afterEach(() => {
  vi.restoreAllMocks();
});

function imprimir(data: PrintOrderData): string {
  let html = '';
  vi.spyOn(window, 'open').mockReturnValue({
    document: { write: (h: string) => { html = h; }, close: () => {} },
  } as unknown as Window);
  openPrintOrder(data);
  return html;
}

// Pedido real oben 12183048572: 1 × 460,25 com R$ 23,01 e 2 × 584,50 com R$ 116,90 de desconto.
const semQuebra: PrintOrderData = {
  companyName: 'OBEN COMÉRCIO LTDA',
  companyCnpj: '51.027.034/0001-00',
  companyPhone: '(37) 9987-8190',
  companyAddress: 'Av. Primeiro de Junho, 70',
  orderNumber: '12780',
  date: '10/09/2026',
  customerName: 'Cliente',
  customerDocument: '',
  items: [
    { codigo: '-', descricao: 'BASE BRIL 20 FOSCO METALIZADA', quantidade: 1, unidade: 'UN', valorUnitario: 460.25, valorTotal: 460.25 },
    { codigo: '-', descricao: 'BASE BRIL 20 FOSCO BRANC', quantidade: 2, unidade: 'UN', valorUnitario: 584.5, valorTotal: 1169 },
  ],
  subtotal: 1629.25,
  desconto: 0,
  frete: 0,
  total: 1629.25,
};

const comQuebra: PrintOrderData = {
  ...semQuebra,
  items: [
    { ...semQuebra.items[0], descontoValor: 23.01, valorTotal: 437.24 },
    { ...semQuebra.items[1], descontoValor: 116.9, valorTotal: 1052.1 },
  ],
  subtotal: 1489.34,
  total: 1489.34,
  quebraDesconto: { subtotalBruto: 1629.25, descontoTotal: 139.91, itensApurados: 2 },
};

describe('openPrintOrder — desconto de item no cupom avulso', () => {
  it('com quebra: coluna Desconto, líquido por linha e Subtotal bruto − Desconto = TOTAL', () => {
    const html = imprimir(comQuebra);
    expect(html.match(/<th[ >]/g)).toHaveLength(8);
    expect(html).toContain('>Desconto</th>');
    expect(html).toContain(`>${fmt(23.01)}</td>`);
    expect(html).toContain(`>${fmt(437.24)}</td>`);
    expect(html).toContain(`>${fmt(116.9)}</td>`);
    expect(html).toContain(`>${fmt(1052.1)}</td>`);
    expect(html).toContain(`<span>Subtotal:</span><span>${fmt(1629.25)}</span>`);
    expect(html).toContain(`<span>Desconto:</span><span>- ${fmt(139.91)}</span>`);
    expect(html).toContain(`<span>TOTAL:</span><span>${fmt(1489.34)}</span>`);
  });

  it('linha não apurada sai "—" no desconto e no total da linha, e o rótulo diz quantos itens', () => {
    const html = imprimir({
      ...comQuebra,
      items: [{ ...comQuebra.items[0], descontoValor: null, valorTotal: null }, comQuebra.items[1]],
      quebraDesconto: { subtotalBruto: 1629.25, descontoTotal: 116.9, itensApurados: 1 },
      total: 1512.35,
    });
    expect(html).toContain('<span>Desconto (1 de 2 itens):</span>');
    expect(html.match(/>—<\/td>/g)).toHaveLength(2);
  });

  it('sem quebra: 7 colunas e só o TOTAL, como hoje', () => {
    const html = imprimir(semQuebra);
    expect(html.match(/<th[ >]/g)).toHaveLength(7);
    expect(html).not.toContain('>Desconto</th>');
    expect(html).not.toContain('<span>Subtotal:</span>');
    expect(html).toContain(`<span>TOTAL:</span><span>${fmt(1629.25)}</span>`);
  });

  it('com quebra, a linha LEGADA de desconto do cabeçalho não duplica o "Desconto"', () => {
    const html = imprimir({ ...comQuebra, desconto: 5, customerDocument: '51.027.034/0001-00' });
    expect(html.match(/<span>Desconto/g)).toHaveLength(1);
    expect(html.match(/<span>Subtotal:/g)).toHaveLength(1);
  });

  it('o aviso à equipe não vai para o papel', () => {
    const html = imprimir({ ...semQuebra, avisoDesconto: 'Pedido 12780: aviso interno' });
    expect(html).not.toContain('aviso interno');
  });
});

describe('openPrintOrder — B4: serviço a orçar no cupom (rodada 2)', () => {
  const base: PrintOrderData = { ...comQuebra, quebraDesconto: undefined };

  it('item sem preço unitário: rodapé diz SUBTOTAL CONHECIDO e quantos itens ficaram sem preço', () => {
    const html = imprimir({
      ...base,
      items: [{ ...base.items[0], valorUnitario: null, valorTotal: null }, base.items[1]],
      total: 50,
    });
    expect(html).toContain(`<span>SUBTOTAL CONHECIDO:</span><span>${fmt(50)}</span>`);
    expect(html).toContain('Total a definir: 1 item sem preço');
    expect(html).not.toContain('<span>TOTAL:</span>');
  });

  it('todos com preço: segue o TOTAL de sempre', () => {
    const html = imprimir({ ...base, total: 50 });
    expect(html).toContain(`<span>TOTAL:</span><span>${fmt(50)}</span>`);
    expect(html).not.toContain('SUBTOTAL CONHECIDO');
  });
});

describe('textoVencimentosDoCupom — vencimento não se inventa', () => {
  it('S41 (Oben = 28/42/56 dias) não vira "41 dias" nem data alguma', () => {
    const t = textoVencimentosDoCupom({ parcelaCode: 'S41', condPagamento: undefined });
    expect(t).toBe('A definir no faturamento — as datas e os valores de cada parcela saem na nota fiscal e nos boletos.');
    expect(t).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(t).not.toContain('41');
  });

  it('à vista ou sem condição: sem linha de vencimentos', () => {
    expect(textoVencimentosDoCupom({ parcelaCode: '000', condPagamento: undefined })).toBe('');
    expect(textoVencimentosDoCupom({ parcelaCode: undefined, condPagamento: '000' })).toBe('');
    expect(textoVencimentosDoCupom({ parcelaCode: 'A01', condPagamento: 'À vista' })).toBe('');
    expect(textoVencimentosDoCupom({ parcelaCode: undefined, condPagamento: undefined })).toBe('');
  });

  it('3 parcelas: nenhum valor por parcela é impresso (o rateio real é do PV, não divisão igual)', () => {
    const t = textoVencimentosDoCupom({ parcelaCode: 'T03', condPagamento: '30/60/90 dias' });
    expect(t).not.toMatch(/R\$/);
    expect(t).not.toContain('ª parcela');
  });
});
