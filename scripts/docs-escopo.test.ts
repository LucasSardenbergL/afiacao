import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { LEITORES_DE_DOCS, caminhosNul, decidir, selecionarTestes } from './docs-escopo';

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
  type Ci = { jobs: Record<string, { needs?: string | string[]; if?: string; steps: { name?: string; run?: string }[] }> };
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as Ci;
  const passo = ci.jobs.validate.steps.find((s) => s.name?.startsWith('Todos os jobs passaram'));
  const temJq = spawnSync('jq', ['--version']).status === 0;
  const PESADOS = ['typecheck', 'testes', 'edges-e-build', 'sonda-cron-prova', 'gates-e-falsificacao', 'hooks', 'evals-falsificacao', 'falsificacao'];

  function needs(escopo: { result: string; so?: string }, gates: string, pesados = 'skipped', exceto: Record<string, string> = {}, provas = 'skipped') {
    const r: Record<string, { result: string; outputs: Record<string, string> }> = {};
    for (const j of PESADOS) r[j] = { result: exceto[j] ?? pesados, outputs: {} };
    r['docs-escopo'] = { result: escopo.result, outputs: escopo.so === undefined ? {} : { so_docs: escopo.so } };
    r['docs-gates'] = { result: gates, outputs: {} };
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

  it('os 8 pesados dependem do escopo e pulam SÓ com success E so_docs=true; docs-gates é o inverso', () => {
    for (const j of PESADOS) {
      expect([ci.jobs[j].needs].flat(), j).toContain('docs-escopo');
      expect(ci.jobs[j].if, j).toBe(
        "${{ !cancelled() && !(needs.docs-escopo.result == 'success' && needs.docs-escopo.outputs.so_docs == 'true') }}",
      );
    }
    expect(ci.jobs['docs-gates'].if).toBe("${{ needs.docs-escopo.result == 'success' && needs.docs-escopo.outputs.so_docs == 'true' }}");
    expect([ci.jobs.validate.needs].flat()).toEqual(expect.arrayContaining(['docs-escopo', 'docs-gates', ...PESADOS]));
    expect([ci.jobs['fail-fast'].needs].flat()).toEqual(expect.arrayContaining(['docs-gates', ...PESADOS]));
  });

  it.skipIf(!temJq)('controles: PR só-docs pulado e PR com código (docs-gates skipped) passam', () => {
    expect(passo?.run).toBeTruthy();
    expect(roda('pull_request', needs({ result: 'success', so: 'true' }, 'success'))).toBe(0);
    expect(roda('pull_request', needs({ result: 'success', so: 'false' }, 'skipped', 'success'))).toBe(0);
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
