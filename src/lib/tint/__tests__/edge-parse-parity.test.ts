import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Paridade textual money-path (P0-B): o edge `tint-import` NÃO importa de src/ (Deno),
// então `parseDecimalBR` vive espelhado nele. Este teste garante que o espelho é VERBATIM
// idêntico à fonte — pega o Lovable reescrevendo o edge no deploy, ou um drift manual.
// (O edge é defesa em profundidade atrás do preflight client-side; ainda assim precisa
// concordar com a fonte, senão temos "dois parsers que discordam" — achado Codex [P1#5].)

const SIG = 'export function parseDecimalBR(input: string): number | null {';

function extractParseDecimalBR(source: string): string {
  const start = source.indexOf(SIG);
  if (start === -1) throw new Error('parseDecimalBR não encontrada no arquivo');
  const rest = source.slice(start);
  const endRel = rest.indexOf('\n}'); // 1ª linha que é só "}" = fim da função (nível 0)
  if (endRel === -1) throw new Error('fim da função parseDecimalBR não encontrado');
  return rest.slice(0, endRel + 2);
}

const normalize = (fn: string): string =>
  fn.split('\n').map((l) => l.trimEnd()).join('\n');

describe('paridade edge tint-import ↔ src parseDecimalBR', () => {
  const root = process.cwd();
  const src = readFileSync(resolve(root, 'src/lib/preco/parse-decimal-br.ts'), 'utf8');
  const edge = readFileSync(resolve(root, 'supabase/functions/tint-import/index.ts'), 'utf8');

  it('o edge espelha a função VERBATIM', () => {
    expect(normalize(extractParseDecimalBR(edge))).toBe(normalize(extractParseDecimalBR(src)));
  });

  it('o edge marca o espelho com MIRROR-START/END', () => {
    expect(edge).toContain('MIRROR-START tint parse-decimal-br');
    expect(edge).toContain('MIRROR-END');
  });

  it('o edge NÃO tem mais o parser bugado (parseFloat + replace)', () => {
    expect(edge).not.toContain('parseFloat(value.trim().replace');
  });
});
