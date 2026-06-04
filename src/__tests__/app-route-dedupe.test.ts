import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/**
 * Guard de segurança: uma rota declarada DUAS vezes (uma aberta + uma dentro de <RequireStaff>)
 * faz o react-router servir a 1ª (aberta) e o gate de staff fica MORTO — foi exatamente a
 * regressão do #508 (todas as rotas de staff duplicadas → governance/financeiro/sales/tint
 * acessíveis por qualquer cliente logado). Este teste falha se qualquer path voltar a duplicar.
 */
const appTsx = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf-8');

describe('App.tsx — paths de rota únicos (gate fail-closed)', () => {
  it('nenhum path é declarado mais de uma vez', () => {
    const paths = [...appTsx.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
    const contagem = new Map<string, number>();
    for (const p of paths) contagem.set(p, (contagem.get(p) ?? 0) + 1);
    const duplicados = [...contagem.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    expect(duplicados).toEqual([]);
  });
});
