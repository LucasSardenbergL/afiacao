import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  DOCUMENTAL,
  INERTES,
  MAX_CANDIDATOS,
  citacoes,
  decidir,
  decidirMain,
  ehAncestral,
  escolherBase,
  inerte,
  jobsDoCorpo,
  provasExecutadas,
  runsDoCorpo,
  lerRepo,
  lidosEmInerte,
  provasVerdes,
  resolverImport,
  type JobDoRun,
  type Repo,
  type RunDaMain,
} from './provas-sql-escopo';

const NENHUM: ReadonlySet<string> = new Set();

function repoFalso(arquivos: Record<string, string>): Repo {
  return {
    arquivos: Object.keys(arquivos),
    ler: (p) => (p in arquivos ? arquivos[p] : null),
    existe: (p) => p in arquivos,
  };
}

describe('provas-sql-escopo — decidir', () => {
  it('fora de pull_request roda TUDO, mesmo com diff só de docs', () => {
    for (const evento of ['push', 'workflow_dispatch', 'schedule', 'merge_group']) {
      expect(decidir(evento, ['docs/x.md'], NENHUM).roda, evento).toBe(true);
    }
  });

  it('diff ilegível, diff VAZIO ou mapa ilegível rodam (ausência de dado não é "nada mudou")', () => {
    expect(decidir('pull_request', null, NENHUM).roda).toBe(true);
    expect(decidir('pull_request', [], NENHUM).roda).toBe(true);
    expect(decidir('pull_request', ['docs/x.md'], null).roda).toBe(true);
  });

  it('PR só de docs/ pula', () => {
    expect(decidir('pull_request', ['docs/historico/a.md', 'docs/historico/README.md'], NENHUM).roda).toBe(false);
  });

  it('PR de src/ comum pula', () => {
    expect(decidir('pull_request', ['src/pages/Recebimento.tsx', 'src/lib/x.test.ts'], NENHUM).roda).toBe(false);
  });

  it('UM arquivo fora do inerte basta para rodar — e o motivo o nomeia', () => {
    const d = decidir('pull_request', ['docs/a.md', 'db/test-x.sh'], NENHUM);
    expect(d.roda).toBe(true);
    expect(d.motivos.join(' ')).toContain('db/test-x.sh');
  });

  it.each([
    'db/test-x.sh',
    'db/lib/qualquer.ts',
    'supabase/migrations/20261104000000_x.sql',
    'supabase/functions/_shared/x.ts',
    'supabase/schema-snapshot.sql',
    'supabase/config.toml',
    'scripts/db-aplicar.sh',
    'scripts/provas-sql-escopo.ts',
    'scripts/mutcheck-escopo.ts',
    '.github/workflows/ci.yml',
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'tsconfig.json',
    'README.md',
    'CLAUDE.md',
    'diretorio-que-ainda-nao-existe/x',
    'srcx/a.ts',
    'docsx.md',
  ])('%s RODA (não é inerte)', (f) => {
    expect(inerte(f, NENHUM)).toBe(false);
    expect(decidir('pull_request', [f], NENHUM).roda).toBe(true);
  });

  it('arquivo lido pelas provas dentro de um inerte RODA — igual, como diretório e sem extensão', () => {
    const lidos = new Set(['src/lib/financeiro/saldo-contas.ts', 'src/lib/gates', 'src/lib/apagado']);
    expect(inerte('src/lib/financeiro/saldo-contas.ts', lidos)).toBe(false);
    expect(inerte('src/lib/gates/passos.ts', lidos)).toBe(false);
    expect(inerte('src/lib/apagado.ts', lidos), 'import de arquivo que o PR apaga').toBe(false);
    expect(inerte('src/lib/gatesX.ts', lidos), 'prefixo de diretório exige a barra').toBe(true);
    expect(decidir('pull_request', ['docs/a.md', 'src/lib/gates/passos.ts'], lidos).roda).toBe(true);
  });

  it('caminho com ./ na frente é normalizado', () => {
    expect(inerte('./docs/a.md', NENHUM)).toBe(true);
  });
});

describe('provas-sql-escopo — o que as provas leem dentro do inerte', () => {
  it('citação literal em db/ conta — inclusive relativa e em comentário; o prefixo nu não', () => {
    expect(citacoes('grep X "$REPO_ROOT/src/lib/financeiro/saldo-contas.ts"')).toEqual(['src/lib/financeiro/saldo-contas.ts']);
    expect(citacoes("import x from '../../src/lib/a';")).toEqual(['src/lib/a']);
    expect(citacoes('# lê .claude/skills/cfo/a.sql.')).toEqual(['.claude/skills/cfo/a.sql']);
    expect(citacoes('-- nenhuma chamada em src/ nem em supabase/')).toEqual([]);
  });

  // A forma como as provas DE FATO citam caminho: raiz em variável. A 1ª versão do regex não
  // casava a `/` antes de `src` — `$REPO_ROOT/src/…` passava invisível.
  it.each([
    ['SKILL_SQL="$REPO_ROOT/.claude/skills/cfo/a.sql"', '.claude/skills/cfo/a.sql'],
    ['grep -c x "${RAIZ}/src/lib/b.ts"', 'src/lib/b.ts'],
    ['cat "$(git rev-parse --show-toplevel)/src/lib/c.ts"', 'src/lib/c.ts'],
    ['bun "$REPO_ROOT/scripts/d.ts"', null],
  ])('raiz em variável: %s', (texto, esperado) => {
    expect(citacoes(texto)).toEqual(esperado === null ? [] : [esperado]);
  });

  it('script citado com raiz em variável entra no fecho', () => {
    const lidos = lidosEmInerte(
      repoFalso({
        'db/test-e.sh': 'node "$REPO_ROOT/scripts/e.ts" && bun ${RAIZ}/scripts/f.mjs',
        'scripts/e.ts': "import { z } from '../src/lib/z';",
        'scripts/f.mjs': "import { w } from '../src/lib/w.js';",
        'src/lib/z.ts': '',
        'src/lib/w.ts': '',
      }),
    );
    expect(inerte('src/lib/z.ts', lidos)).toBe(false);
    expect(inerte('src/lib/w.ts', lidos)).toBe(false);
  });

  it('caminho aninhado em outro diretório NÃO é citação da raiz', () => {
    expect(citacoes('supabase/functions/x/src/lib/y.ts')).toEqual([]);
  });

  it('docs/ citado em comentário NÃO conta (é a concessão documentada no script)', () => {
    expect(citacoes('# detalhe em docs/agent/database.md')).toEqual([]);
  });

  it('resolve @/, relativo, .js→.ts, index.ts; pacote fica de fora', () => {
    const existe = (p: string) => ['src/lib/a.ts', 'scripts/lib/b.ts', 'src/lib/c/index.ts'].includes(p);
    expect(resolverImport('scripts/x.ts', '@/lib/a', existe)).toEqual({ base: 'src/lib/a', existentes: ['src/lib/a.ts'] });
    expect(resolverImport('db/lib/y.ts', '../../scripts/lib/b.js', existe)).toEqual({
      base: 'scripts/lib/b',
      existentes: ['scripts/lib/b.ts'],
    });
    expect(resolverImport('scripts/x.ts', '../src/lib/c', existe)).toEqual({
      base: 'src/lib/c',
      existentes: ['src/lib/c/index.ts'],
    });
    expect(resolverImport('scripts/x.ts', 'node:fs', existe)).toBeNull();
    expect(resolverImport('scripts/x.ts', 'vitest', existe)).toBeNull();
    expect(resolverImport('scripts/x.ts', '@/lib/sumiu', existe), 'não resolvido fica do lado seguro').toEqual({
      base: 'src/lib/sumiu',
      existentes: [],
    });
  });

  // Parecer Codex 2026-11-04: o Bun prefere `.tsx` a `.ts`. Um PR que acrescente `route-city.tsx` ao
  // lado do `.ts` muda o que o oráculo da prova carrega — e o escopo antigo, que escolhia o `.ts`,
  // dava roda=false.
  it('.ts e .tsx coexistindo: o PR que acrescenta o .tsx RODA (o lido é a base sem extensão)', () => {
    const arquivos = {
      'db/test-venda-gerador.sh': 'bun scripts/venda-cidades-alvo-esperado.ts',
      'scripts/venda-cidades-alvo-esperado.ts': "import { r } from '../src/lib/whatsapp/route-city';",
      'src/lib/whatsapp/route-city.ts': '',
    };
    const lidos = lidosEmInerte(repoFalso({ ...arquivos, 'src/lib/whatsapp/route-city.tsx': '' }));
    expect(decidir('pull_request', ['src/lib/whatsapp/route-city.tsx'], lidos).roda).toBe(true);
    // e o caso de antes do PR, com só o .ts: tocar QUALQUER variante roda
    const antes = lidosEmInerte(repoFalso(arquivos));
    for (const f of ['src/lib/whatsapp/route-city.ts', 'src/lib/whatsapp/route-city.tsx', 'src/lib/whatsapp/route-city.mts']) {
      expect(decidir('pull_request', [f], antes).roda, f).toBe(true);
    }
  });

  it('o fecho segue TODOS os candidatos existentes, não só o primeiro', () => {
    const lidos = lidosEmInerte(
      repoFalso({
        'db/lib/g.ts': "import { a } from '../../src/lib/dupla';",
        'src/lib/dupla.ts': "import { b } from './so-do-ts';",
        'src/lib/dupla.tsx': "import { c } from './so-do-tsx';",
        'src/lib/so-do-ts.ts': '',
        'src/lib/so-do-tsx.ts': '',
      }),
    );
    expect(inerte('src/lib/so-do-ts.ts', lidos)).toBe(false);
    expect(inerte('src/lib/so-do-tsx.ts', lidos)).toBe(false);
  });

  it('fecho transitivo: db/*.sh → scripts/*.ts citado → ../src → @/ → src', () => {
    const lidos = lidosEmInerte(
      repoFalso({
        'db/test-a.sh': 'bun scripts/esperado.ts "$X"',
        'db/lib/gera.ts': "import { f } from '../../scripts/lib/leitor';",
        'scripts/esperado.ts': "import { g } from '../src/lib/farmer/u';",
        'scripts/lib/leitor.ts': "import { h } from '@/lib/gates/limpeza';\nexport const k = await import('./dinamico');",
        'scripts/lib/dinamico.ts': "const r = require('../../src/lib/r');",
        'src/lib/farmer/u.ts': "import { v } from './v';",
        'src/lib/farmer/v.ts': '',
        'src/lib/gates/limpeza.ts': '',
        'src/lib/r.ts': '',
        'src/lib/solto.ts': "import { u } from './farmer/u';",
        'scripts/nao-citado.ts': "import '../src/lib/solto';",
      }),
    );
    for (const f of ['src/lib/farmer/u.ts', 'src/lib/farmer/v.ts', 'src/lib/gates/limpeza.ts', 'src/lib/r.ts']) {
      expect(inerte(f, lidos), f).toBe(false);
    }
    // `solto` só é alcançado por um script que nenhuma prova cita: segue inerte.
    expect(inerte('src/lib/solto.ts', lidos)).toBe(true);
  });

  it('INERTES não inclui nada que as provas sabidamente leem por inteiro', () => {
    for (const p of ['db/', 'supabase/', 'scripts/', '.github/']) expect(INERTES).not.toContain(p);
  });

  // Âncora do mapa de 2026-11-04 sobre a árvore REAL: o cálculo tem de achar o que o mapa achou à
  // mão. Se uma destas sair, a prova deixou de ler — ou o cálculo cegou; os dois pedem olho.
  it('na árvore real, o cálculo acha as leituras que o mapa de 2026-11-04 achou à mão', () => {
    const repo = lerRepo();
    expect(repo).not.toBeNull();
    const lidos = lidosEmInerte(repo!);
    for (const f of [
      'src/lib/financeiro/saldo-contas.ts',
      'src/lib/farmer/universo-pedidos.ts',
      'src/lib/whatsapp/route-city.ts',
      'src/lib/gates/limpeza-fonte.ts',
      'src/lib/erro-mensagem.ts',
      '.claude/skills/cfo-colacor/assets/sql/01-caixa-13-semanas.sql',
    ]) {
      expect(inerte(f, lidos), f).toBe(false);
    }
    expect(inerte('docs/historico/README.md', lidos)).toBe(true);
    expect(inerte('src/pages/Index.tsx', lidos)).toBe(true);
  });
});

// ─── Escopo da MAIN (E14 do plano v7) ─────────────────────────────────────────────────────────────
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const PARTES_OK: JobDoRun[] = [1, 2, 3, 4, 5, 6, 7].map((k) => ({ name: `provas-sql (${k})`, conclusion: 'success' }));
const VERDE: JobDoRun[] = [...PARTES_OK, { name: 'provas-sql-uniao', conclusion: 'success' }, { name: 'validate', conclusion: 'failure' }];

describe('provas-sql-escopo — provasVerdes (o que conta como base)', () => {
  it('união e todas as partes success é base — mesmo com OUTRO job vermelho no run', () => {
    expect(provasVerdes(VERDE)).toBe(true);
  });

  it.each([
    ['união skipped (run que o escopo pulou)', [...PARTES_OK, { name: 'provas-sql-uniao', conclusion: 'skipped' }]],
    ['união ausente', PARTES_OK],
    ['união null (em andamento/ilegível)', [...PARTES_OK, { name: 'provas-sql-uniao', conclusion: null }]],
    ['sem nenhuma parte', [{ name: 'provas-sql-uniao', conclusion: 'success' }]],
    [
      'uma parte cancelled',
      [...PARTES_OK.slice(1), { name: 'provas-sql (1)', conclusion: 'cancelled' }, { name: 'provas-sql-uniao', conclusion: 'success' }],
    ],
    [
      'partes skipped e união success',
      [{ name: 'provas-sql (1)', conclusion: 'skipped' }, { name: 'provas-sql-uniao', conclusion: 'success' }],
    ],
  ] as [string, JobDoRun[]][])('%s NÃO é base', (_n, jobs) => {
    expect(provasVerdes(jobs)).toBe(false);
  });
});

describe('provas-sql-escopo — provasExecutadas e os corpos da API', () => {
  it('executou = alguma parte ou a união com conclusão que não seja skipped', () => {
    expect(provasExecutadas(VERDE)).toBe(true);
    expect(provasExecutadas([{ name: 'provas-sql-uniao', conclusion: 'skipped' }, { name: 'provas-sql (1)', conclusion: 'skipped' }])).toBe(false);
    expect(provasExecutadas([{ name: 'validate', conclusion: 'failure' }])).toBe(false);
    expect(provasExecutadas([])).toBe(false);
    expect(provasExecutadas([{ name: 'provas-sql (2)', conclusion: null }])).toBe(true);
    expect(provasExecutadas([{ name: 'provas-sql-escopo', conclusion: 'success' }])).toBe(false);
  });

  it('jobsDoCorpo: página incompleta, total ausente ou forma estranha ⇒ null', () => {
    const jobs = [{ name: 'provas-sql-uniao', conclusion: 'success' }, { name: 'provas-sql (1)', conclusion: null }];
    expect(jobsDoCorpo({ total_count: 2, jobs })).toEqual([
      { name: 'provas-sql-uniao', conclusion: 'success' },
      { name: 'provas-sql (1)', conclusion: null },
    ]);
    expect(jobsDoCorpo({ total_count: 130, jobs })).toBeNull();
    expect(jobsDoCorpo({ jobs })).toBeNull();
    expect(jobsDoCorpo({ total_count: '2', jobs })).toBeNull();
    expect(jobsDoCorpo({ total_count: 0 })).toBeNull();
    expect(jobsDoCorpo(null)).toBeNull();
    expect(jobsDoCorpo({ message: 'Server Error' })).toBeNull();
  });

  it('runsDoCorpo: lê id/evento/sha/branch/repo; forma estranha ⇒ null', () => {
    const r = runsDoCorpo({
      workflow_runs: [{ id: 7, event: 'workflow_dispatch', head_sha: A, head_branch: 'main', head_repository: { full_name: 'o/r' } }, { id: 8 }],
    });
    expect(r?.[0]).toEqual({ id: 7, event: 'workflow_dispatch', head_sha: A, head_branch: 'main', repo: 'o/r' });
    // Campos ausentes viram valores que o filtro do escolherBase recusa.
    expect(escolherBase(r!.slice(1), 99, 'o/r', () => VERDE).sha).toBeNull();
    expect(runsDoCorpo({ message: 'Server Error' })).toBeNull();
    expect(runsDoCorpo(null)).toBeNull();
  });
});

describe('provas-sql-escopo — escolherBase', () => {
  const run = (id: number, sha: string, extra: Partial<RunDaMain> = {}): RunDaMain => ({
    id,
    event: 'workflow_dispatch',
    head_sha: sha,
    head_branch: 'main',
    repo: 'o/r',
    ...extra,
  });
  const PULADO: JobDoRun[] = [{ name: 'provas-sql-uniao', conclusion: 'skipped' }];

  it('pega o run MAIS RECENTE com provas verdes, pulando os de provas puladas', () => {
    const jobs: Record<number, JobDoRun[]> = { 3: PULADO, 2: VERDE, 1: VERDE };
    const b = escolherBase([run(3, B), run(2, A), run(1, B)], 99, 'o/r', (id) => jobs[id]);
    expect(b.sha).toBe(A);
  });

  it('ignora o run atual, run de pull_request, de outra branch e de outro repo', () => {
    const ruins = [
      run(99, B),
      run(5, B, { event: 'pull_request' }),
      run(6, B, { head_branch: 'feature' }),
      run(7, B, { repo: 'fork/r' }),
      run(8, 'curto'),
    ];
    const b = escolherBase([...ruins, run(1, A)], 99, 'o/r', () => VERDE);
    expect(b.sha).toBe(A);
  });

  it('o run mais recente que EXECUTOU as provas e não ficou verde corta a busca: sem base', () => {
    // Vermelho sem mudança de código (relógio, intermitência): um dispatch só de docs não pode achar a
    // base verde mais antiga da MESMA árvore e apagar o diagnóstico (ressalva do Codex).
    const vermelho: JobDoRun[] = [...PARTES_OK.slice(1), { name: 'provas-sql (1)', conclusion: 'failure' }, { name: 'provas-sql-uniao', conclusion: 'failure' }];
    const jobs: Record<number, JobDoRun[]> = { 3: PULADO, 2: vermelho, 1: VERDE };
    const b = escolherBase([run(3, B), run(2, A), run(1, A)], 99, 'o/r', (id) => jobs[id]);
    expect(b.sha).toBeNull();
    expect(b.motivo).toContain('2');
    // Run que nem tem os jobs (pendente coalescido) é atravessado, como o pulado.
    expect(escolherBase([run(4, B), run(1, A)], 99, 'o/r', (id) => (id === 4 ? [] : VERDE)).sha).toBe(A);
  });

  it('jobs ilegíveis num candidato PARAM a busca, sem base (não pula para um mais antigo)', () => {
    const jobs: Record<number, JobDoRun[] | null> = { 2: null, 1: VERDE };
    expect(escolherBase([run(2, B), run(1, A)], 99, 'o/r', (id) => jobs[id]).sha).toBeNull();
  });

  it(`olha no máximo ${MAX_CANDIDATOS} candidatos; nenhum verde = sem base`, () => {
    const runs = Array.from({ length: MAX_CANDIDATOS + 5 }, (_, i) => run(1000 - i, A));
    let consultas = 0;
    const b = escolherBase(runs, 99, 'o/r', () => {
      consultas++;
      return PULADO;
    });
    expect(b.sha).toBeNull();
    expect(consultas).toBe(MAX_CANDIDATOS);
    expect(escolherBase([], 99, 'o/r', () => VERDE).sha).toBeNull();
  });
});

describe('provas-sql-escopo — decidirMain', () => {
  const base = { sha: A, motivo: 'run 1 com provas e união verdes' };
  const ok = { sha: B, base, ancestral: true as boolean | null, mudados: ['docs/historico/x.md', 'docs/README.md'] };

  it('diff cumulativo só de docs/, desde base verde ancestral: PULA e devolve a base', () => {
    const d = decidirMain(ok);
    expect(d.roda).toBe(false);
    expect(d.base).toBe(A);
    expect(DOCUMENTAL).toBe('docs/');
  });

  // A allowlist do PR NÃO vale na main: src/, public/, .claude/ e arquivo de raiz rodam.
  it.each(['src/pages/Index.tsx', 'public/robots.txt', '.claude/skills/x/SKILL.md', 'CLAUDE.md', 'README.md', 'docsx/a.md', 'db/test-x.sh'])(
    'UM %s no diff cumulativo basta para rodar',
    (f) => {
      const d = decidirMain({ ...ok, mudados: ['docs/a.md', f] });
      expect(d.roda).toBe(true);
      expect(d.base).toBeUndefined();
      expect(d.motivos.join(' ')).toContain(f);
    },
  );

  it.each([
    ['base desconhecida', { base: { sha: null, motivo: 'nenhum' } }],
    ['base malformada', { base: { sha: 'A'.repeat(40), motivo: 'x' } }],
    ['base = o próprio SHA', { base: { sha: B, motivo: 'x' } }],
    ['base não ancestral', { ancestral: false }],
    ['ancestralidade inconclusiva', { ancestral: null }],
    ['diff ilegível', { mudados: null }],
    ['diff vazio', { mudados: [] }],
    ['SHA do run inválido', { sha: '' }],
  ] as [string, Partial<typeof ok>][])('%s → roda TUDO', (_n, mudanca) => {
    const d = decidirMain({ ...ok, ...mudanca });
    expect(d.roda).toBe(true);
    expect(d.base).toBeUndefined();
  });
});

describe('provas-sql-escopo — ehAncestral (git real)', () => {
  it('true para ancestral, false para descendente, null para objeto ausente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'escopo-anc-'));
    try {
      const git = (...a: string[]) =>
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
          cwd: dir,
          encoding: 'utf8',
        }).trim();
      git('init', '-q');
      writeFileSync(join(dir, 'a'), '1');
      git('add', 'a');
      git('commit', '-qm', 'um');
      const c1 = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'a'), '2');
      git('commit', '-qam', 'dois');
      const c2 = git('rev-parse', 'HEAD');
      expect(ehAncestral(c1, c2, dir)).toBe(true);
      expect(ehAncestral(c2, c1, dir)).toBe(false);
      expect(ehAncestral('f'.repeat(40), c2, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// O step REAL do `validate`, extraído do ci.yml e executado sob cenários de `needs`. Fail-closed: o
// skip só é aceito nas duas combinações autorizadas; qualquer outra reprova.
describe('ci.yml — validate aceita o skip das provas só onde o escopo pode pular', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  const passo = ci.jobs.validate.steps.find((s) => s.name?.startsWith('Todos os jobs passaram'));
  const temJq = spawnSync('jq', ['--version']).status === 0;

  function needs(escopo: { result: string; roda?: string; base?: string }, provas = 'skipped') {
    const outputs: Record<string, string> = {};
    if (escopo.roda !== undefined) outputs.roda = escopo.roda;
    if (escopo.base !== undefined) outputs.base = escopo.base;
    const ok = { result: 'success', outputs: {} };
    return JSON.stringify({
      typecheck: ok,
      testes: ok,
      'edges-e-build': ok,
      'gates-e-falsificacao': ok,
      falsificacao: ok,
      'provas-sql-escopo': { result: escopo.result, outputs },
      'provas-sql': { result: provas, outputs: {} },
      'provas-sql-uniao': { result: provas, outputs: {} },
    });
  }
  function roda(env: Record<string, string>): number {
    const r = spawnSync('bash', ['-c', passo!.run!], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    return r.status ?? -1;
  }
  const MAIN = { EVENTO: 'workflow_dispatch', REF: 'refs/heads/main', ESCOPO_DOCS: 'true' };
  const PULOU_MAIN = needs({ result: 'success', roda: 'false', base: A });

  it.skipIf(!temJq)('controles: PR pulado, dispatch pós-merge pulado e tudo success passam', () => {
    expect(passo?.run).toBeTruthy();
    expect(roda({ EVENTO: 'pull_request', REF: 'refs/pull/1/merge', ESCOPO_DOCS: '', RESULTADOS: needs({ result: 'success', roda: 'false' }) })).toBe(0);
    expect(roda({ ...MAIN, RESULTADOS: PULOU_MAIN })).toBe(0);
    for (const evento of ['push', 'schedule', 'workflow_dispatch']) {
      expect(
        roda({ EVENTO: evento, REF: 'refs/heads/main', ESCOPO_DOCS: '', RESULTADOS: needs({ result: 'success', roda: 'true' }, 'success') }),
        evento,
      ).toBe(0);
    }
  });

  it.skipIf(!temJq).each([
    ['dispatch sem o input', { ...MAIN, ESCOPO_DOCS: 'false' }, PULOU_MAIN],
    ['dispatch com input vazio', { ...MAIN, ESCOPO_DOCS: '' }, PULOU_MAIN],
    ['dispatch fora da main', { ...MAIN, REF: 'refs/heads/feature' }, PULOU_MAIN],
    ['dispatch sem base', MAIN, needs({ result: 'success', roda: 'false' })],
    ['dispatch com base curta', MAIN, needs({ result: 'success', roda: 'false', base: A.slice(1) })],
    ['dispatch com base em caixa alta', MAIN, needs({ result: 'success', roda: 'false', base: A.toUpperCase() })],
    ['dispatch com base e lixo', MAIN, needs({ result: 'success', roda: 'false', base: `${A}\nx` })],
    ['push forjando o pulo', { ...MAIN, EVENTO: 'push' }, PULOU_MAIN],
    ['schedule forjando o pulo', { ...MAIN, EVENTO: 'schedule' }, PULOU_MAIN],
    ['escopo failure', MAIN, needs({ result: 'failure', roda: 'false', base: A })],
    ['escopo cancelled', MAIN, needs({ result: 'cancelled', roda: 'false', base: A })],
    ['roda=true com provas puladas', MAIN, needs({ result: 'success', roda: 'true', base: A })],
    ['roda=FALSE', MAIN, needs({ result: 'success', roda: 'FALSE', base: A })],
    ['saída vazia', MAIN, needs({ result: 'success' })],
    ['PR com escopo failure', { EVENTO: 'pull_request', REF: 'x', ESCOPO_DOCS: '' }, needs({ result: 'failure', roda: 'false' })],
  ] as [string, Record<string, string>, string][])('%s reprova', (_n, env, resultados) => {
    expect(roda({ ...env, RESULTADOS: resultados })).toBe(1);
  });

  it.skipIf(!temJq)('o skip aceito é SÓ de provas-sql e da união: outro job pulado reprova', () => {
    const j = JSON.parse(PULOU_MAIN);
    j.testes = { result: 'skipped', outputs: {} };
    expect(roda({ ...MAIN, RESULTADOS: JSON.stringify(j) })).toBe(1);
  });
});

// A fiação da CLI: o modo da main SÓ entra com dispatch + input true + ref main. Fora disso, nem
// consulta a API — cai no `decidir`, que roda tudo fora de PR. (Sem rede: nenhum caso chega no `gh`.)
describe('provas-sql-escopo — CLI só entra no modo da main com dispatch, input e ref certos', () => {
  it.each([
    ['input false', ['--evento', 'workflow_dispatch', '--escopo-docs', 'false', '--ref', 'refs/heads/main']],
    ['input vazio', ['--evento', 'workflow_dispatch', '--escopo-docs', '', '--ref', 'refs/heads/main']],
    ['outra ref', ['--evento', 'workflow_dispatch', '--escopo-docs', 'true', '--ref', 'refs/heads/feature']],
    ['push com input', ['--evento', 'push', '--escopo-docs', 'true', '--ref', 'refs/heads/main']],
    ['schedule com input', ['--evento', 'schedule', '--escopo-docs', 'true', '--ref', 'refs/heads/main']],
  ])('%s → roda TUDO sem procurar base', (_n, args) => {
    const dir = mkdtempSync(join(tmpdir(), 'escopo-cli-'));
    try {
      const saida = join(dir, 'out');
      writeFileSync(saida, '');
      const r = spawnSync('bun', ['./scripts/provas-sql-escopo.ts', ...args, '--sha', A, '--repo', 'o/r', '--run-id', '1', '--github-output'], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: saida, GH_TOKEN: 'x' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('fora de PR roda TUDO');
      expect(r.stdout).not.toContain('base');
      expect(readFileSync(saida, 'utf8')).toBe('roda=true\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
