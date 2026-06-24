import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// resolverCustoCockpit é a régua de custo do COCKPIT de valor (A3) — carrega a flag `baixaConfianca` da margem,
// money-path. Roda em DOIS runtimes: vitest/Vite (canônico em src/lib/custos/cost-source.ts) e Deno (espelho no
// edge supabase/functions/fin-valor-cockpit/index.ts — Deno não importa de src/). Este teste prova que o CORPO da
// função é byte-idêntico nos dois (a partir de `function …`, ignorando só o prefixo `export` do canônico), pegando
// o drift que o comentário "espelhado VERBATIM" não garante (Codex P2 2026-06-23). Mesma defesa do costLadder.parity.
const ROOT = process.cwd();

function corpoResolverCustoCockpit(arquivo: string): string {
  const txt = readFileSync(resolve(ROOT, arquivo), 'utf8');
  const m = txt.match(/function resolverCustoCockpit\b[^]*?\n\}/);
  if (!m) throw new Error(`resolverCustoCockpit não encontrada em ${arquivo}`);
  return m[0];
}

describe('paridade: resolverCustoCockpit (src/lib/custos/cost-source.ts × edge fin-valor-cockpit/index.ts)', () => {
  it('o corpo da função é byte-idêntico nos dois runtimes (anti-drift do espelho money-path)', () => {
    const src = corpoResolverCustoCockpit('src/lib/custos/cost-source.ts');
    const edge = corpoResolverCustoCockpit('supabase/functions/fin-valor-cockpit/index.ts');
    expect(edge).toBe(src);
  });
});
