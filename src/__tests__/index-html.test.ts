import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regressão: o iOS/Safari auto-detecta números de telefone em texto e os transforma
// em <a href="tel:"> — inclusive o número da Central de Telefonia. Sem esta meta, o
// toque abre o app Telefone do SO em vez de chamar via NVOIP. NÃO remover.
describe('index.html — meta format-detection (anti auto-link tel: do iOS)', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf-8');

  it('contém <meta name="format-detection" content="telephone=no"> (ordem dos atributos indiferente)', () => {
    const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
    const found = metas.some(
      (tag) =>
        /name\s*=\s*"format-detection"/i.test(tag) &&
        /content\s*=\s*"telephone=no"/i.test(tag)
    );
    expect(found).toBe(true);
  });
});
