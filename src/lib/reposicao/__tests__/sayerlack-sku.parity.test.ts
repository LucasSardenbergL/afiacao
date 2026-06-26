import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O parser sayerlack-sku é a fonte da verdade money-path do de-para de fornecedor
// (descrição Omie → código do portal Sayerlack) e roda em DOIS runtimes: vitest/Vite
// (canônico em src/) e Deno (espelho no edge — Deno não importa de src/). Este teste prova
// que os dois arquivos são byte-idênticos. Divergência = CI vermelho, evitando que uma
// correção no regex entre em um runtime e não no outro (de-para errado = PO errado no
// fornecedor — o modo de falha que reposicao.md/money-path.md alertam). Mesmo padrão do
// costLadder.parity.test.ts.
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/reposicao/sayerlack-sku.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/sayerlack-sku.ts');

describe('paridade: sayerlack-sku (src) × sayerlack-sku (edge)', () => {
  it('os dois arquivos são byte-idênticos', () => {
    const canonico = readFileSync(CANONICO, 'utf8');
    const espelho = readFileSync(ESPELHO, 'utf8');
    expect(espelho).toBe(canonico);
  });
});
