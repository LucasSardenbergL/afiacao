import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O helper da captura de preços é money-path e roda em DOIS runtimes: vitest/Vite
// (canônico em src/) e Deno (espelho no edge — Deno não importa de src/). Este teste
// prova que os dois arquivos são byte-idênticos. Divergência = CI vermelho, evitando
// que uma correção entre em um runtime e não no outro (padrão cost-ladder).
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/reposicao/embalagem-captura-helpers.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/embalagem-captura-helpers.ts');

describe('paridade: embalagem-captura-helpers (src) × _shared (edge)', () => {
  it('os dois arquivos são byte-idênticos', () => {
    const canonico = readFileSync(CANONICO, 'utf8');
    const espelho = readFileSync(ESPELHO, 'utf8');
    expect(espelho).toBe(canonico);
  });
});
