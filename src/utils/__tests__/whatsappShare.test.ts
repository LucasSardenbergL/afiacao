/**
 * @vitest-environment jsdom
 *
 * Exceção ao particionamento por extensão (`projects` em vitest.config.ts): este é um
 * `.ts` — logo, no ambiente `node` por padrão — mas toca DOM. O docblock sobrepõe o
 * project e é local ao arquivo, então não vira ímã de conflito entre worktrees.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { shareOrderViaWhatsApp } from '../whatsappShare';

let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
});
afterEach(() => {
  openSpy.mockRestore();
});

/** Extrai e decodifica o `text=` da URL passada pro window.open. */
function decodedMessage(): string {
  expect(openSpy).toHaveBeenCalledTimes(1);
  const [url, target] = openSpy.mock.calls[0];
  expect(String(url)).toMatch(/^https:\/\/wa\.me\/\?text=/);
  expect(target).toBe('_blank');
  const text = String(url).replace('https://wa.me/?text=', '');
  return decodeURIComponent(text);
}

const fixedDate = new Date(2026, 4, 15, 9, 30); // 15/05/2026 09:30 (TZ local — só checamos o ano)

describe('shareOrderViaWhatsApp', () => {
  it('abre wa.me/?text= num _blank com a mensagem codificada', () => {
    shareOrderViaWhatsApp({
      customerName: 'ACME LTDA',
      items: [{ description: 'Lixa', quantity: 2, unitPrice: 10 }],
      total: 20,
      date: fixedDate,
    });
    const msg = decodedMessage();
    expect(msg).toContain('*Pedido Colacor*');
    expect(msg).toContain('Cliente: ACME LTDA');
    expect(msg).toContain('Data:');
    expect(msg).toContain('2026');
  });

  it('formata cada item: • qtd x descrição - total em BRL (qtd × preço)', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [{ description: 'Disco', quantity: 3, unitPrice: 50 }],
      total: 150,
      date: fixedDate,
    });
    const msg = decodedMessage();
    expect(msg).toContain('• 3x Disco');
    expect(msg).toContain('R$'); // moeda
    expect(msg).toContain('150,00'); // 3 × 50
    expect(msg).toContain('*Total:');
  });

  it('inclui a cor da tinta quando tintCorId está presente', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [{ description: 'Base', quantity: 1, unitPrice: 100, tintCorId: 'COR123', tintNomeCor: 'Azul Profundo' }],
      total: 100,
      date: fixedDate,
    });
    const msg = decodedMessage();
    expect(msg).toContain('Cor: COR123');
    expect(msg).toContain('Azul Profundo');
  });

  it('omite a cor quando não há tintCorId', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [{ description: 'Base', quantity: 1, unitPrice: 100 }],
      total: 100,
      date: fixedDate,
    });
    expect(decodedMessage()).not.toContain('Cor:');
  });

  it('lista os números de pedido quando fornecidos (juntos por " + ")', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [{ description: 'A', quantity: 1, unitPrice: 1 }],
      total: 1,
      orderNumbers: ['PV 100', 'PV 200'],
      date: fixedDate,
    });
    expect(decodedMessage()).toContain('Pedido(s): PV 100 + PV 200');
  });

  it('omite a linha de pedido quando orderNumbers está vazio', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [{ description: 'A', quantity: 1, unitPrice: 1 }],
      total: 1,
      date: fixedDate,
    });
    expect(decodedMessage()).not.toContain('Pedido(s):');
  });

  it('múltiplos itens viram múltiplas linhas', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [
        { description: 'A', quantity: 1, unitPrice: 1 },
        { description: 'B', quantity: 2, unitPrice: 2 },
      ],
      total: 5,
      date: fixedDate,
    });
    const msg = decodedMessage();
    expect(msg).toContain('• 1x A');
    expect(msg).toContain('• 2x B');
  });
});

// Desconto de item: o total de cada linha e a quebra Subtotal/Desconto chegam JÁ CALCULADOS e
// CONFERIDOS por quem chama (vendas, com a régua do cupom). Este módulo não confere conta nenhuma —
// escreve a que recebeu, com os rótulos do cupom impresso. Pedido real oben 12183048572:
// 1 × 460,25 − 23,01 = 437,24 · 2 × 584,50 − 116,90 = 1.052,10 · 1.629,25 − 139,91 = 1.489,34.
describe('shareOrderViaWhatsApp — desconto de item', () => {
  const NBSP = ' '; // o toLocaleString('pt-BR') separa "R$" do número com espaço NÃO separável

  it('sem lineTotal nem quebraDesconto, a mensagem é a de sempre, byte a byte', () => {
    shareOrderViaWhatsApp({
      customerName: 'ACME LTDA',
      items: [
        { description: 'BASE METALIZADA', quantity: 1, unitPrice: 460.25 },
        { description: 'BASE BRANCA', quantity: 2, unitPrice: 584.5 },
      ],
      total: 1629.25,
      orderNumbers: ['12183048572'],
      date: '14/09/2026',
    });
    expect(decodedMessage()).toBe(
      '*Pedido Colacor*\n\nCliente: ACME LTDA\nPedido(s): 12183048572\n\nItens:\n' +
        `• 1x BASE METALIZADA - R$${NBSP}460,25\n• 2x BASE BRANCA - R$${NBSP}1.169,00\n\n` +
        `*Total: R$${NBSP}1.629,25*\n\nData: 14/09/2026`,
    );
  });

  it('lineTotal informado substitui quantidade × preço na linha, sem inventar Subtotal/Desconto', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [{ description: 'BASE METALIZADA', quantity: 1, unitPrice: 460.25, lineTotal: 437.24 }],
      total: 437.24,
      date: '14/09/2026',
    });
    const msg = decodedMessage();
    expect(msg).toContain(`• 1x BASE METALIZADA - R$${NBSP}437,24\n`);
    expect(msg).not.toContain('460,25');
    expect(msg).not.toContain('Subtotal');
    expect(msg).not.toContain('Desconto');
  });

  it('lineTotal null (líquido não sabido) sai "—" — nunca a conta bruta, nunca R$ 0,00', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [{ description: 'BASE BRANCA', quantity: 2, unitPrice: 584.5, lineTotal: null }],
      total: 1052.1,
      date: '14/09/2026',
    });
    expect(decodedMessage()).toContain('• 2x BASE BRANCA - —\n');
  });

  it('com quebraDesconto, Subtotal e Desconto entram antes do Total — os rótulos do cupom', () => {
    shareOrderViaWhatsApp({
      customerName: 'ACME LTDA',
      items: [
        { description: 'BASE METALIZADA', quantity: 1, unitPrice: 460.25, lineTotal: 437.24 },
        { description: 'BASE BRANCA', quantity: 2, unitPrice: 584.5, lineTotal: 1052.1 },
      ],
      total: 1489.34,
      orderNumbers: ['12183048572'],
      date: '14/09/2026',
      quebraDesconto: { subtotalBruto: 1629.25, descontoTotal: 139.91, itensApurados: 2 },
    });
    expect(decodedMessage()).toBe(
      '*Pedido Colacor*\n\nCliente: ACME LTDA\nPedido(s): 12183048572\n\nItens:\n' +
        `• 1x BASE METALIZADA - R$${NBSP}437,24\n• 2x BASE BRANCA - R$${NBSP}1.052,10\n\n` +
        `Subtotal: R$${NBSP}1.629,25\nDesconto: - R$${NBSP}139,91\n` +
        `*Total: R$${NBSP}1.489,34*\n\nData: 14/09/2026`,
    );
  });

  it('desconto parcial: o rótulo diz quantos itens entraram e a linha não apurada sai "—"', () => {
    shareOrderViaWhatsApp({
      customerName: 'X',
      items: [
        { description: 'BASE METALIZADA', quantity: 1, unitPrice: 460.25, lineTotal: 437.24 },
        { description: 'BASE BRANCA', quantity: 2, unitPrice: 584.5, lineTotal: null },
      ],
      total: 1606.24,
      date: '14/09/2026',
      quebraDesconto: { subtotalBruto: 1629.25, descontoTotal: 23.01, itensApurados: 1 },
    });
    const msg = decodedMessage();
    expect(msg).toContain('• 2x BASE BRANCA - —\n');
    expect(msg).toContain(
      `\n\nSubtotal: R$${NBSP}1.629,25\nDesconto (1 de 2 itens): - R$${NBSP}23,01\n*Total: R$${NBSP}1.606,24*`,
    );
  });
});
