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
