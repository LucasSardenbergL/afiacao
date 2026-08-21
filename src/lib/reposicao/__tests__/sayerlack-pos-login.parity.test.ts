import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A confirmação de dashboard pós-login é money-path e roda em DOIS runtimes:
// vitest/Vite (canônico em src/) e Deno (espelho no edge — Deno não importa de
// src/). Byte-idênticos ou CI vermelho: sem isso, uma correção entra num runtime
// e não no outro. Mesmo padrão de embalagem-captura-helpers.parity.test.ts.
const ROOT = process.cwd();
const CANONICO = resolve(ROOT, 'src/lib/reposicao/sayerlack-pos-login.ts');
const ESPELHO = resolve(ROOT, 'supabase/functions/_shared/sayerlack-pos-login.ts');

describe('paridade: sayerlack-pos-login (src) × _shared (edge)', () => {
  it('os dois arquivos são byte-idênticos', () => {
    expect(readFileSync(ESPELHO, 'utf8')).toBe(readFileSync(CANONICO, 'utf8'));
  });

  it('classificarPosLogin é interpolável no Browserless (sem crase nem ${)', () => {
    // A função é enviada ao Chrome remoto via `${classificarPosLogin.toString()}`
    // dentro de um template literal. Crase ou `${` no corpo quebram o script inteiro
    // em RUNTIME — no portal, longe do CI. Guard textual, como o resto da família.
    const src = readFileSync(CANONICO, 'utf8');
    const inicio = src.indexOf('export function classificarPosLogin');
    expect(inicio).toBeGreaterThan(-1);
    const corpo = src.slice(inicio, src.indexOf('\nexport interface AlertaPortal'));
    expect(corpo.includes('`')).toBe(false);
    expect(corpo.includes('${')).toBe(false);
  });
});
