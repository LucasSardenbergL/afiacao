import { describe, it, expect } from 'vitest';
import { decodeHtml, statusDoPedido, statusLabels } from '../types';

describe('decodeHtml', () => {
  it('decodifica entidades HTML comuns', () => {
    expect(decodeHtml('Tintas &amp; Vernizes')).toBe('Tintas & Vernizes');
    expect(decodeHtml('&lt;b&gt;')).toBe('<b>');
    expect(decodeHtml('O&apos;Brien')).toBe("O'Brien");
    expect(decodeHtml('&quot;x&quot;')).toBe('"x"');
  });
  it('deixa texto sem entidades intacto', () => {
    expect(decodeHtml('ACME Ltda')).toBe('ACME Ltda');
  });
});

describe('statusLabels', () => {
  it('mapeia status conhecidos', () => {
    expect(statusLabels.enviado.label).toBe('Enviado ao Omie');
    expect(statusLabels.cancelado.variant).toBe('destructive');
  });
});

describe('statusDoPedido', () => {
  it('status gravados pelo sync do Omie ganham rótulo próprio (antes caíam no fallback "Rascunho")', () => {
    expect(statusDoPedido('importado').label).toBe('Importado');
    expect(statusDoPedido('separacao').label).toBe('Em separação');
  });

  it('status conhecidos preservados', () => {
    expect(statusDoPedido('rascunho').label).toBe('Rascunho');
    expect(statusDoPedido('faturado').label).toBe('Faturado');
  });

  it('status desconhecido → rótulo honesto derivado do próprio status, NUNCA "Rascunho"', () => {
    const s = statusDoPedido('aguardando_aprovacao');
    expect(s.label).toBe('Aguardando aprovacao');
    expect(s.label).not.toBe('Rascunho');
    expect(s.variant).toBe('outline');
  });

  it('status vazio → rótulo neutro', () => {
    expect(statusDoPedido('').label).toBe('Sem status');
  });
});
