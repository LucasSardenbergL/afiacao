import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { LEITORES_DE_DOCS, caminhosNul, decidir, lerParte, particionar, pesoDe, selecionarTestes } from './docs-escopo';

const OK = (caminhos: string[]) => ({ status: 0, caminhos });

describe('decidir — só docs/**/*.md num PR pula', () => {
  it('controle: PR só com Markdown em docs/ pula', () => {
    expect(decidir('pull_request', 2, OK(['docs/historico/a.md', 'docs/agent/deploy.md'])).soDocs).toBe(true);
  });

  it.each([
    ['push da main', 'push', 2, OK(['docs/a.md'])],
    ['dispatch', 'workflow_dispatch', 2, OK(['docs/a.md'])],
    ['schedule', 'schedule', 2, OK(['docs/a.md'])],
    ['evento vazio', '', 2, OK(['docs/a.md'])],
    ['HEAD sem merge (1 pai)', 'pull_request', 1, OK(['docs/a.md'])],
    ['pais ilegíveis', 'pull_request', null, OK(['docs/a.md'])],
    ['git diff falhou', 'pull_request', 2, { status: 128, caminhos: ['docs/a.md'] }],
    ['git diff sem status', 'pull_request', 2, { status: null, caminhos: ['docs/a.md'] }],
    ['diff vazio', 'pull_request', 2, OK([])],
    ['CLAUDE.md na raiz', 'pull_request', 2, OK(['docs/a.md', 'CLAUDE.md'])],
    ['README.md na raiz', 'pull_request', 2, OK(['README.md'])],
    ['.mjs em docs/ (o eslint lê)', 'pull_request', 2, OK(['docs/x/logica.mjs'])],
    ['.sh em docs/ (os fiscais de shell leem)', 'pull_request', 2, OK(['docs/x/a.sh'])],
    ['.mut em docs/', 'pull_request', 2, OK(['docs/specs/a.mut'])],
    ['.md fora de docs/', 'pull_request', 2, OK(['.claude/skills/x/SKILL.md'])],
    ['docs sem barra (prefixo falso)', 'pull_request', 2, OK(['docsx/a.md'])],
    ['docs/.md sem nome', 'pull_request', 2, OK(['docs/.md'.replace('/.md', '.md')])],
    ['código junto', 'pull_request', 2, OK(['docs/a.md', 'src/x.ts'])],
  ] as [string, string, number | null, { status: number | null; caminhos: string[] }][])('%s → roda tudo', (_n, ev, pais, diff) => {
    expect(decidir(ev, pais, diff).soDocs).toBe(false);
  });

  it('caminhosNul descarta o NUL final e preserva espaço no nome', () => {
    expect(caminhosNul('docs/a b.md\0docs/c.md\0')).toEqual(['docs/a b.md', 'docs/c.md']);
    expect(caminhosNul('')).toEqual([]);
  });
});

describe('selecionarTestes — superconjunto textual ∪ leitores conhecidos', () => {
  const universo = [...LEITORES_DE_DOCS, 'src/x.test.tsx', 'src/y.spec.ts', 'scripts/z.test.ts', 'src/nao-teste.ts', 'db/w.test.ts'];

  it('leitor conhecido entra mesmo sem citar docs; o que cita entra; fora do universo não', () => {
    const textos: Record<string, string> = { 'src/x.test.tsx': 'lê CLAUDE.md', 'src/y.spec.ts': "join('docs', 'a')", 'scripts/z.test.ts': 'nada' };
    const s = selecionarTestes(universo, (f) => textos[f] ?? 'nada');
    expect(s.erro).toBeNull();
    expect(s.arquivos).toEqual([...LEITORES_DE_DOCS, 'src/x.test.tsx', 'src/y.spec.ts'].sort());
  });

  it('leitor conhecido ausente reprova (fail-closed, não encolhe calado)', () => {
    const s = selecionarTestes(universo.filter((f) => f !== 'scripts/authz-carimbo.test.ts'), () => 'nada');
    expect(s.erro).toMatch(/authz-carimbo/);
    expect(s.arquivos).toEqual([]);
  });

  it('na árvore real: os leitores existem e a seleção os contém', () => {
    const rastreados = caminhosNul(execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const s = selecionarTestes(rastreados, (f) => readFileSync(f, 'utf8'));
    expect(s.erro).toBeNull();
    for (const f of LEITORES_DE_DOCS) expect(s.arquivos).toContain(f);
  });
});

// O step REAL do `validate`, extraído do ci.yml e executado sob cenários de `needs`.
describe('ci.yml — validate aceita os 8 pesados skipped só com o escopo só-docs', () => {
  type Passo = { name?: string; id?: string; if?: string; run?: string };
  type Ci = {
    jobs: Record<
      string,
      { needs?: string | string[]; if?: string; strategy?: { matrix?: { parte?: number[] } }; outputs?: Record<string, string>; steps: Passo[] }
    >;
  };
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as Ci;
  const passo = ci.jobs.validate.steps.find((s) => s.name?.startsWith('Todos os jobs passaram'));
  const temJq = spawnSync('jq', ['--version']).status === 0;
  const PESADOS = ['typecheck', 'testes', 'edges-e-build', 'sonda-cron-prova', 'gates-e-falsificacao', 'hooks', 'evals-falsificacao', 'falsificacao'];

  const TODAS = { parte_1: 'rodou', parte_2: 'rodou', parte_3: 'rodou' };
  function needs(
    escopo: { result: string; so?: string },
    gates: string,
    pesados = 'skipped',
    exceto: Record<string, string> = {},
    provas = 'skipped',
    marcas: Record<string, string> = escopo.so === 'true' ? TODAS : {},
  ) {
    const r: Record<string, { result: string; outputs: Record<string, string> }> = {};
    for (const j of PESADOS) r[j] = { result: exceto[j] ?? pesados, outputs: {} };
    r['docs-escopo'] = { result: escopo.result, outputs: escopo.so === undefined ? {} : { so_docs: escopo.so } };
    r['docs-gates'] = { result: gates, outputs: marcas };
    // Fora de PR as provas não pulam por `inerte`: o fixture as põe `success` para que só o escopo
    // só-docs decida o veredito (senão o caso reprova pelas provas, não pelo que testa).
    r['provas-sql-escopo'] = { result: 'success', outputs: provas === 'skipped' ? { roda: 'false', modo: 'inerte' } : { roda: 'true' } };
    r['provas-sql'] = { result: provas, outputs: {} };
    return JSON.stringify(r);
  }
  // A união é step do `validate` desde 2026-11-12: chega ao agregador como `UNIAO` (o `outcome`), e
  // acompanha as partes — pula com elas, passa com elas.
  function roda(evento: string, resultados: string): number {
    const uniao = (JSON.parse(resultados) as Record<string, { result: string }>)['provas-sql'].result;
    const env = { PATH: process.env.PATH ?? '', EVENTO: evento, REF: 'refs/pull/1/merge', ESCOPO_DOCS: '', RESULTADOS: resultados, UNIAO: uniao };
    return spawnSync('bash', ['-c', passo!.run!], { env, encoding: 'utf8' }).status ?? -1;
  }

  it('os 8 pesados dependem do escopo e pulam SÓ com success E so_docs=true; o docs-gates não espera ninguém', () => {
    for (const j of PESADOS) {
      expect([ci.jobs[j].needs].flat(), j).toContain('docs-escopo');
      expect(ci.jobs[j].if, j).toBe(
        "${{ !cancelled() && !(needs.docs-escopo.result == 'success' && needs.docs-escopo.outputs.so_docs == 'true') }}",
      );
    }
    // Em paralelo com o escopo: sem `needs` nem `if` de job — decide sozinho, no step `escopo`.
    expect(ci.jobs['docs-gates'].needs).toBeUndefined();
    expect(ci.jobs['docs-gates'].if).toBeUndefined();
    expect([ci.jobs.validate.needs].flat()).toEqual(expect.arrayContaining(['docs-escopo', 'docs-gates', ...PESADOS]));
    expect([ci.jobs['fail-fast'].needs].flat()).toEqual(expect.arrayContaining(['docs-gates', ...PESADOS]));
  });

  it.skipIf(!temJq)('controles: PR só-docs pulado (3 marcas) e PR com código (docs-gates verde sem marca) passam', () => {
    expect(passo?.run).toBeTruthy();
    expect(roda('pull_request', needs({ result: 'success', so: 'true' }, 'success'))).toBe(0);
    expect(roda('pull_request', needs({ result: 'success', so: 'false' }, 'success', 'success'))).toBe(0);
    // Marca sobrando fora do só-docs não muda nada: os pesados rodaram e respondem por si.
    expect(roda('pull_request', needs({ result: 'success', so: 'false' }, 'success', 'success', {}, 'skipped', TODAS))).toBe(0);
  });

  it.skipIf(!temJq).each([
    ['docs-gates failure', 'pull_request', needs({ result: 'success', so: 'true' }, 'failure')],
    ['docs-gates skipped com so_docs=true', 'pull_request', needs({ result: 'success', so: 'true' }, 'skipped')],
    ['docs-gates cancelled', 'pull_request', needs({ result: 'success', so: 'true' }, 'cancelled')],
    ['escopo failure', 'pull_request', needs({ result: 'failure', so: 'true' }, 'success')],
    ['escopo sem saída', 'pull_request', needs({ result: 'success' }, 'success')],
    ['so_docs=TRUE', 'pull_request', needs({ result: 'success', so: 'TRUE' }, 'success')],
    ['so_docs=false com pesados pulados', 'pull_request', needs({ result: 'success', so: 'false' }, 'skipped')],
    ['push forjando o pulo', 'push', needs({ result: 'success', so: 'true' }, 'success', 'skipped', {}, 'success')],
    ['dispatch forjando o pulo', 'workflow_dispatch', needs({ result: 'success', so: 'true' }, 'success', 'skipped', {}, 'success')],
    ['pesado CANCELADO no pulo', 'pull_request', needs({ result: 'success', so: 'true' }, 'success', 'skipped', { testes: 'cancelled' })],
    ['pesado failure no pulo', 'pull_request', needs({ result: 'success', so: 'true' }, 'success', 'skipped', { typecheck: 'failure' })],
    ['docs-gates skipped com escopo falho', 'pull_request', needs({ result: 'failure', so: 'false' }, 'skipped', 'success')],
    // O docs-gates não tem mais `if`: skipped é sempre ausência de dado, mesmo com os pesados verdes.
    ['docs-gates skipped fora do só-docs', 'pull_request', needs({ result: 'success', so: 'false' }, 'skipped', 'success')],
    // O `success` do docs-gates não prova que testou: uma parte que discordou do escopo sai verde sem marca.
    ['só-docs sem a marca da parte 2', 'pull_request', needs({ result: 'success', so: 'true' }, 'success', 'skipped', {}, 'skipped', { parte_1: 'rodou', parte_3: 'rodou' })],
    ['só-docs sem nenhuma marca', 'pull_request', needs({ result: 'success', so: 'true' }, 'success', 'skipped', {}, 'skipped', {})],
    ['só-docs com marca em caixa trocada', 'pull_request', needs({ result: 'success', so: 'true' }, 'success', 'skipped', {}, 'skipped', { ...TODAS, parte_3: 'RODOU' })],
  ] as [string, string, string][])('%s reprova', (_n, evento, resultados) => {
    expect(roda(evento, resultados)).toBe(1);
  });

  // Controle e caso na MESMA forma: tudo success, 12 jobs — só a conferência de presença distingue.
  it.skipIf(!temJq).each(['docs-escopo', 'docs-gates'])('sem o %s nos needs (trocado por outro job success), reprova', (falta) => {
    const r = JSON.parse(needs({ result: 'success', so: 'false' }, 'success', 'success')) as Record<string, unknown>;
    expect(roda('pull_request', JSON.stringify(r))).toBe(0);
    delete r[falta];
    r['outro'] = { result: 'success', outputs: {} };
    expect(roda('pull_request', JSON.stringify(r))).toBe(1);
  });
});

describe('docs-gates — as N partes casam a matriz, os steps, as saídas e o validate', () => {
  type Passo = { name?: string; id?: string; if?: string; run?: string };
  type Job = { strategy?: { matrix?: { parte?: number[] } }; outputs?: Record<string, string>; steps: Passo[] };
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> };
  const job = ci.jobs['docs-gates'];
  const partes = job.strategy?.matrix?.parte ?? [];
  const N = partes.length;

  it('matriz 1..N, um step de teste ESTÁTICO por parte, uma saída por parte e a marca como ÚLTIMO step', () => {
    expect(N).toBeGreaterThan(1);
    expect(partes).toEqual(Array.from({ length: N }, (_, k) => k + 1));
    const testes = job.steps.filter((p) => p.run?.includes('--testes'));
    expect(testes.map((p) => p.run)).toEqual(partes.map((i) => `bun ./scripts/docs-escopo.ts --testes --parte ${i}/${N}`));
    expect(testes.map((p) => p.if)).toEqual(partes.map((i) => `matrix.parte == ${i} && steps.escopo.outputs.so_docs == 'true'`));
    expect(job.outputs).toEqual(Object.fromEntries(partes.map((i) => [`parte_${i}`, `\${{ steps.marca.outputs.parte_${i} }}`])));
    const ultimo = job.steps[job.steps.length - 1];
    expect(ultimo.id).toBe('marca');
    expect(ultimo.if).toBe("steps.escopo.outputs.so_docs == 'true'");
    expect(ultimo.run).toBe('echo "parte_${PARTE}=rodou" >> "$GITHUB_OUTPUT"');
    // Todo step depois do escopo é condicionado a ele: fora do só-docs nada roda.
    const i = job.steps.findIndex((p) => p.id === 'escopo');
    expect(job.steps[i].run).toBe('bun ./scripts/docs-escopo.ts --evento "$EVENTO"');
    for (const p of job.steps.slice(i + 1)) expect(p.if, p.name).toMatch(/steps\.escopo\.outputs\.so_docs == 'true'$/);
  });

  it('o validate exige exatamente as N marcas', () => {
    const run = (ci.jobs.validate.steps as Passo[]).map((p) => p.run ?? '').join('\n');
    expect(run).toContain(`(${partes.map((i) => `.parte_${i}`).join(', ')})`);
    expect(run).toContain(`[ "$docs_marcas" = ${partes.map(() => 'rodou').join(',')} ]`);
  });

  it('na árvore real: as N partes são disjuntas, não-vazias, e a união é a seleção inteira', () => {
    const rastreados = caminhosNul(execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const s = selecionarTestes(rastreados, (f) => readFileSync(f, 'utf8'));
    expect(s.erro).toBeNull();
    const ps = particionar(s.arquivos, pesoDe, N);
    expect(ps).toHaveLength(N);
    for (const p of ps) expect(p.length).toBeGreaterThan(0);
    const todas = ps.flat();
    expect(new Set(todas).size).toBe(todas.length);
    expect([...todas].sort()).toEqual(s.arquivos);
  });
});

describe('particionar / lerParte', () => {
  it('LPT determinístico: maior para a parte mais leve, união = entrada, ordem de entrada irrelevante', () => {
    const peso: Record<string, number> = { a: 5, b: 4, c: 3, d: 3, e: 1 };
    const ps = particionar(['e', 'd', 'c', 'b', 'a'], (f) => peso[f], 2);
    expect(ps).toEqual([['a', 'd'], ['b', 'c', 'e']]);
    expect(particionar(['a', 'b', 'c', 'd', 'e'], (f) => peso[f], 2)).toEqual(ps);
  });

  it('mais partes que arquivos deixa parte vazia (o modo --testes reprova nela)', () => {
    expect(particionar(['a'], () => 1, 2)).toEqual([['a'], []]);
  });

  it.each([['1/3', { i: 1, n: 3 }], ['3/3', { i: 3, n: 3 }]] as const)('lerParte(%s)', (t, esperado) => {
    expect(lerParte(t)).toEqual(esperado);
  });

  it.each(['0/3', '4/3', '1/0', '01/3', '1/3 ', '-1/3', '1', '', 'a/b'])('lerParte(%j) é inválida', (t) => {
    expect(lerParte(t)).toBeNull();
  });
});

describe('modo --evento escreve so_docs no GITHUB_OUTPUT', () => {
  it('fora de PR escreve false; sem GITHUB_OUTPUT sai 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-escopo-'));
    try {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = spawnSync('bun', ['./scripts/docs-escopo.ts', '--evento', 'push'], { env: { ...process.env, GITHUB_OUTPUT: out }, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('so_docs=false\n');
      const env = { ...process.env };
      delete env.GITHUB_OUTPUT;
      expect(spawnSync('bun', ['./scripts/docs-escopo.ts', '--evento', 'push'], { env, encoding: 'utf8' }).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
