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

// Par do parser OFX: o espelho difere do canônico SÓ na linha de import do núcleo
// ('./extrato-nucleo.ts' na edge, './nucleo.ts' no src). Normaliza essa linha e compara o resto.
const PARSER_CANONICO = resolve(ROOT, 'src/lib/financeiro/extrato/parser-ofx.ts');
const PARSER_ESPELHO = resolve(ROOT, 'supabase/functions/_shared/extrato-parser-ofx.ts');
const normalizarImport = (s: string) => s.split("'./extrato-nucleo.ts'").join("'./nucleo.ts'");

describe('paridade: extrato/parser-ofx (src) × extrato-parser-ofx (edge)', () => {
  it('idênticos após normalizar a linha de import do núcleo', () => {
    const espelho = readFileSync(PARSER_ESPELHO, 'utf8');
    expect(espelho.includes("'./extrato-nucleo.ts'")).toBe(true);
    expect(identicos(normalizarImport(espelho), readFileSync(PARSER_CANONICO, 'utf8'))).toBe(true);
  });

  it('CALIBRAÇÃO: divergência de 1 byte fora do import reprova; a normalização não mascara', () => {
    const canonico = readFileSync(PARSER_CANONICO, 'utf8');
    const adulterado = normalizarImport(readFileSync(PARSER_ESPELHO, 'utf8')).replace('LEDGERBAL', 'LEDGERBAL2');
    expect(adulterado).not.toBe(canonico);
    expect(identicos(adulterado, canonico)).toBe(false);
    expect(canonico.includes("'./nucleo.ts'")).toBe(true);
    expect(identicos(readFileSync(PARSER_ESPELHO, 'utf8'), canonico)).toBe(false); // sem normalizar, o import difere
  });

  it('CALIBRAÇÃO: caminhos distintos e não-vazios', () => {
    expect(PARSER_CANONICO).not.toBe(PARSER_ESPELHO);
    expect(readFileSync(PARSER_CANONICO, 'utf8').length).toBeGreaterThan(1000);
    expect(readFileSync(PARSER_ESPELHO, 'utf8').includes('export function parseOfx')).toBe(true);
  });
});

