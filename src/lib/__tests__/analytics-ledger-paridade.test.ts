import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Paridade entre a allowlist do ledger no BANCO (a última migration que recria
 * `analytics_ledger_registrar`) e o tipo `EventoLedger` do front.
 *
 * Por quê: o ledger é fail-open — evento fora da allowlist volta 22023, vira um `logger.warn` e some.
 * Um evento no TS que o banco não aceita é sinal decisório que nunca chega, sem ninguém ver; um
 * evento no banco que o TS não conhece é escrita aberta sem consumidor. Os dois lados mudam em PRs
 * diferentes (migration manual × código), então a paridade é travada aqui, lendo o texto dos dois.
 */
const RAIZ = resolve(__dirname, '../../..');

function allowlistDaUltimaMigration(): { arquivo: string; eventos: string[] } {
  const dir = resolve(RAIZ, 'supabase/migrations');
  const candidatas = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => /CREATE OR REPLACE FUNCTION public\.analytics_ledger_registrar/.test(readFileSync(resolve(dir, f), 'utf8')));
  const arquivo = candidatas[candidatas.length - 1];
  const sql = readFileSync(resolve(dir, arquivo), 'utf8');
  const m = /IF p_evento NOT IN \(([^)]*)\) THEN/.exec(sql);
  if (!m) throw new Error(`${arquivo}: allowlist do ledger não encontrada`);
  return { arquivo, eventos: [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() };
}

function eventosDoTipo(): string[] {
  const ts = readFileSync(resolve(RAIZ, 'src/lib/analytics-ledger.ts'), 'utf8');
  const bloco = /export type EventoLedger =([\s\S]*?);/.exec(ts);
  if (!bloco) throw new Error('src/lib/analytics-ledger.ts: tipo EventoLedger não encontrado');
  const semComentario = bloco[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...semComentario.matchAll(/\|\s*'([^']+)'/g)].map((x) => x[1]).sort();
}

describe('ledger de analytics — paridade banco × front', () => {
  it('a allowlist da última migration é exatamente o tipo EventoLedger', () => {
    const { arquivo, eventos } = allowlistDaUltimaMigration();
    expect(eventos.length, `${arquivo} sem eventos?`).toBeGreaterThan(0);
    expect(eventosDoTipo(), `allowlist de ${arquivo}`).toEqual(eventos);
  });

  it('o evento do card de crescimento está nos dois lados', () => {
    expect(allowlistDaUltimaMigration().eventos).toContain('dashboard.crescimento_comparavel_servido');
    expect(eventosDoTipo()).toContain('dashboard.crescimento_comparavel_servido');
  });
});
