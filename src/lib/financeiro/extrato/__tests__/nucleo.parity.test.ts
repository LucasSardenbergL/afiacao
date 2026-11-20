import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A edge (Deno, `--no-remote`) não importa de `src/`; então o núcleo é duplicado e a verdade é
// provada por bytes. Molde: src/lib/gates/__tests__/limpeza-fonte.parity.test.ts.
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/financeiro/extrato/nucleo.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/extrato-nucleo.ts');

// Mesma função de comparação para o teste real e para a calibração.
const identicos = (a: string, b: string) => a === b;

describe('paridade: extrato/nucleo (src) × extrato-nucleo (edge)', () => {
  it('os dois arquivos são byte-idênticos', () => {
    expect(identicos(readFileSync(ESPELHO, 'utf8'), readFileSync(CANONICO, 'utf8'))).toBe(true);
  });

  // Controle positivo de divergência: uma cópia alterada em 1 byte TEM de reprovar na comparação.
  it('CALIBRAÇÃO: divergência de 1 byte deixa a paridade vermelha', () => {
    const canonico = readFileSync(CANONICO, 'utf8');
    const adulterado = canonico.replace('centavos', 'centavoz');
    expect(adulterado).not.toBe(canonico);
    expect(identicos(adulterado, canonico)).toBe(false);
    expect(identicos(canonico + ' ', canonico)).toBe(false);
  });

  it('CALIBRAÇÃO: caminhos distintos e não-vazios', () => {
    expect(CANONICO).not.toBe(ESPELHO);
    expect(readFileSync(CANONICO, 'utf8').length).toBeGreaterThan(1000);
    expect(readFileSync(ESPELHO, 'utf8').includes('export function chavesDasLinhas')).toBe(true);
  });
});
