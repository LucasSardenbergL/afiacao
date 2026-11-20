import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A edge (Deno, `--no-remote`) não importa de `src/`; então o núcleo é duplicado e a verdade é
// provada por bytes. Molde: src/lib/gates/__tests__/limpeza-fonte.parity.test.ts.
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/financeiro/extrato/nucleo.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/extrato-nucleo.ts');

describe('paridade: extrato/nucleo (src) × extrato-nucleo (edge)', () => {
  it('os dois arquivos são byte-idênticos', () => {
    expect(readFileSync(ESPELHO, 'utf8')).toBe(readFileSync(CANONICO, 'utf8'));
  });

  it('CALIBRAÇÃO: caminhos distintos e não-vazios', () => {
    expect(CANONICO).not.toBe(ESPELHO);
    expect(readFileSync(CANONICO, 'utf8').length).toBeGreaterThan(1000);
    expect(readFileSync(ESPELHO, 'utf8').includes('export function chavesDasLinhas')).toBe(true);
  });
});
