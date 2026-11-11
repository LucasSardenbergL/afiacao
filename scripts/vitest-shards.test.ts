import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Os SHARDS do vitest no CI (E10 do plano v6, 2 → 4 em 2026-11-11). O job `testes` do ci.yml roda
 * `test:shard:1..N` em matriz — um shard por runner. O `--shard=k/N` do vitest só cobre a suíte
 * inteira se TODO k de 1..N rodar com o MESMO N: um shard faltando (matriz `[1,2,3]` com N=4) ou
 * um N divergente (`--shard=3/3` ao lado de `1/4`) deixa arquivos de teste que rodam no laptop e
 * NUNCA no CI, com o `validate` verde — ausência de dado, não aprovação. É isso que se prova aqui,
 * estaticamente (o mesmo desenho de scripts/falsificacao-cobertura.test.ts para as fatias):
 *
 *   · os scripts `test:shard:k` são 1..N sem buraco, e cada um é exatamente `vitest run --shard=k/N`;
 *   · `matrix.shard` do job `testes` é exatamente 1..N;
 *   · há UM step por shard, `run: bun run test:shard:k` com `if: matrix.shard == k` casado;
 *   · `testes` continua no `needs` do `validate` (a matriz agrega: success só se todos passarem).
 */
export function shardsDoPkg(scripts: Record<string, string>): { k: number; nome: string; cmd: string }[] {
  return Object.keys(scripts)
    .map((nome) => ({ nome, m: /^test:shard:(\d+)$/.exec(nome) }))
    .filter((x): x is { nome: string; m: RegExpExecArray } => x.m !== null)
    .map(({ nome, m }) => ({ k: Number(m[1]), nome, cmd: scripts[nome] }))
    .sort((a, b) => a.k - b.k);
}

const RAIZ = join(import.meta.dirname, '..');

describe('shards do vitest no CI', () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const shards = shardsDoPkg(pkg.scripts);
  const n = shards.length;

  it('há pelo menos 2 shards, numerados 1..N sem buraco', () => {
    expect(n).toBeGreaterThanOrEqual(2);
    expect(shards.map((s) => s.k)).toEqual(shards.map((_, i) => i + 1));
  });

  it('cada shard é exatamente `vitest run --shard=k/N`, com o MESMO N', () => {
    expect(shards.map((s) => s.cmd.trim())).toEqual(shards.map((s) => `vitest run --shard=${s.k}/${n}`));
  });

  it('ci.yml: job `testes` em matriz 1..N com UM step por shard, `if` casado com o script', () => {
    const ci = parse(readFileSync(join(RAIZ, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { strategy?: { matrix?: { shard?: unknown } }; steps?: { run?: unknown; if?: unknown }[]; needs?: unknown }>;
    };
    const job = ci.jobs.testes;
    expect(job, 'o job `testes` sumiu do ci.yml').toBeTruthy();
    expect(job.strategy?.matrix?.shard).toEqual(shards.map((s) => s.k));

    const steps = (job.steps ?? []).filter((s) => typeof s.run === 'string' && /bun run test:shard/.test(s.run as string));
    expect(steps.map((s) => String(s.run).trim())).toEqual(shards.map((s) => `bun run ${s.nome}`));
    for (const [i, s] of steps.entries()) {
      const cond = String(s.if ?? '').replace(/\$\{\{|\}\}/g, '').trim();
      expect(cond, `o step de ${shards[i].nome} não está gateado pelo shard ${shards[i].k}`).toBe(`matrix.shard == ${shards[i].k}`);
    }
    const needs = ci.jobs.validate?.needs;
    expect(Array.isArray(needs) && needs.includes('testes'), '`testes` saiu do needs do validate').toBe(true);
  });
});
