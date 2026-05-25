import { describe, it, expect } from 'vitest';
import { decodeHtml, statusLabels } from '../types';

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
