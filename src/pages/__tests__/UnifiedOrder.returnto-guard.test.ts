import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Open redirect no `?returnTo=` da fila (triagem das dependências, 2026-11-18).
 *
 * O guard caseiro (`startsWith('/') && !startsWith('//')`) deixava passar `/\evil.example`: o navegador
 * lê a contrabarra como barra, o `pushState` recusa a outra origem e o react-router <6.30.6 cai em
 * `window.location.assign` — o "Voltar à fila" levava para fora do app. O destino tem de passar pelo
 * MESMO guard do login (`caminhoInternoSeguro`, coberto em `login-honra-destino.test.tsx`, que já
 * exige recusar `/\x.com`). Este teste prende a FIAÇÃO: o valor que chega ao `navigate` sai do guard.
 */
const fonte = readFileSync(resolve(__dirname, '../UnifiedOrder.tsx'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

describe('UnifiedOrder: ?returnTo= passa pelo guard do login', () => {
  it('o returnTo nasce de caminhoInternoSeguro sobre o parâmetro da URL', () => {
    expect(fonte).toMatch(/const returnTo = caminhoInternoSeguro\(searchParams\.get\('returnTo'\)\);/);
  });

  it('o parâmetro cru não é lido em nenhum outro lugar', () => {
    expect(fonte.match(/searchParams\.get\('returnTo'\)/g)).toHaveLength(1);
  });

  it('o guard caseiro, que aceitava /\\host, não volta', () => {
    expect(fonte).not.toMatch(/startsWith\('\/\/'\)/);
  });
});
