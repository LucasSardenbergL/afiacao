import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O helper de custo é a fonte da verdade money-path e roda em DOIS runtimes: vitest/Vite
// (canônico em src/) e Deno (espelho no edge — Deno não importa de src/). Este teste prova
// que os dois arquivos são byte-idênticos. Divergência = CI vermelho, evitando que uma
// correção entre em um runtime e não no outro (o modo de falha que money-path.md alerta).
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/custo/costLadder.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/cost-ladder.ts');

describe('paridade: costLadder (src) × cost-ladder (edge)', () => {
  it('os dois arquivos são byte-idênticos', () => {
    const canonico = readFileSync(CANONICO, 'utf8');
    const espelho = readFileSync(ESPELHO, 'utf8');
    expect(espelho).toBe(canonico);
  });
});
