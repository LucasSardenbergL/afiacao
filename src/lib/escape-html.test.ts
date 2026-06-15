import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('escapa os 5 caracteres perigosos', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('trata o & PRIMEIRO (sem duplo-escape das entidades)', () => {
    // Se < virasse &lt; antes de & ser escapado, o & da entidade viraria &amp;lt;
    expect(escapeHtml('Tom & <b>')).toBe('Tom &amp; &lt;b&gt;');
  });

  it('neutraliza payload de <img onerror> (XSS stored)', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const out = escapeHtml(payload);
    expect(out).not.toContain('<img');
    expect(out).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('neutraliza <script>', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('deixa texto limpo intacto (não muda o visual)', () => {
    expect(escapeHtml('Marcenaria Silva & Cia')).toBe('Marcenaria Silva &amp; Cia');
    expect(escapeHtml('Rua das Flores, 123')).toBe('Rua das Flores, 123');
    expect(escapeHtml('')).toBe('');
  });
});
