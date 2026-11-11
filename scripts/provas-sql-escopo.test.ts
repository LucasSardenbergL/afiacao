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
  TITULO_RECIBO,
  anotacaoRecibo,
  decidirRecibo,
  escolherRecibo,
  fatosGitDoRecibo,
  mergeDaAnotacao,
  mergeDoCheckout,
  rotaDoCheckRun,
  type FatosRecibo,
  type JobComId,
  type RunDoPr,
} from './provas-sql-escopo';

const NENHUM: ReadonlySet<string> = new Set();

function lidosDe(repo: Repo): Set<string> {
  const l = lidosEmInerte(repo);
  if (l === null) throw new Error('mapa de leitura null num repo legível');
  return l;
}

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
    const lidos = lidosDe(
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
    const lidos = lidosDe(repoFalso({ ...arquivos, 'src/lib/whatsapp/route-city.tsx': '' }));
    expect(decidir('pull_request', ['src/lib/whatsapp/route-city.tsx'], lidos).roda).toBe(true);
    // e o caso de antes do PR, com só o .ts: tocar QUALQUER variante roda
    const antes = lidosDe(repoFalso(arquivos));
    for (const f of ['src/lib/whatsapp/route-city.ts', 'src/lib/whatsapp/route-city.tsx', 'src/lib/whatsapp/route-city.mts']) {
      expect(decidir('pull_request', [f], antes).roda, f).toBe(true);
    }
  });

  it('o fecho segue TODOS os candidatos existentes, não só o primeiro', () => {
    const lidos = lidosDe(
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
    const lidos = lidosDe(
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
    const lidos = lidosDe(repo!);
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

  function needs(escopo: { result: string; roda?: string; base?: string; modo?: string; recibo?: string }, provas = 'skipped') {
    const outputs: Record<string, string> = {};
    if (escopo.roda !== undefined) outputs.roda = escopo.roda;
    if (escopo.base !== undefined) outputs.base = escopo.base;
    if (escopo.modo !== undefined) outputs.modo = escopo.modo;
    if (escopo.recibo !== undefined) outputs.recibo = escopo.recibo;
    const ok = { result: 'success', outputs: {} };
    return JSON.stringify({
      typecheck: ok,
      testes: ok,
      'edges-e-build': ok,
      'sonda-cron-prova': ok,
      'gates-e-falsificacao': ok,
      'hooks-e-evals': ok,
      falsificacao: ok,
      'provas-sql-escopo': { result: escopo.result, outputs },
      'provas-sql': { result: provas, outputs: {} },
      'provas-sql-uniao': { result: provas, outputs: {} },
    });
  }
  function roda(env: Record<string, string>, path = process.env.PATH ?? ''): number {
    const r = spawnSync('bash', ['-c', passo!.run!], { env: { PATH: path, ...env }, encoding: 'utf8' });
    return r.status ?? -1;
  }
  const MAIN = { EVENTO: 'workflow_dispatch', REF: 'refs/heads/main', ESCOPO_DOCS: 'true' };
  const PULOU_MAIN = needs({ result: 'success', roda: 'false', base: A, modo: 'main-docs' });

  it.skipIf(!temJq)('controles: PR pulado, dispatch pós-merge pulado e tudo success passam', () => {
    expect(passo?.run).toBeTruthy();
    expect(roda({ EVENTO: 'pull_request', REF: 'refs/pull/1/merge', ESCOPO_DOCS: '', RESULTADOS: needs({ result: 'success', roda: 'false', modo: 'inerte' }) })).toBe(0);
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
    ['dispatch sem base', MAIN, needs({ result: 'success', roda: 'false', modo: 'main-docs' })],
    ['dispatch sem modo', MAIN, needs({ result: 'success', roda: 'false', base: A })],
    ['dispatch com modo do PR', MAIN, needs({ result: 'success', roda: 'false', base: A, modo: 'inerte' })],
    ['PR pulado sem modo', { EVENTO: 'pull_request', REF: 'x', ESCOPO_DOCS: '' }, needs({ result: 'success', roda: 'false' })],
    ['PR com modo da main', { EVENTO: 'pull_request', REF: 'x', ESCOPO_DOCS: '' }, needs({ result: 'success', roda: 'false', modo: 'main-docs', base: A })],
    ['PR com parte CANCELADA (fail-fast) e escopo que mandou rodar', { EVENTO: 'pull_request', REF: 'x', ESCOPO_DOCS: '' }, needs({ result: 'success', roda: 'true' }, 'cancelled')],
    ['PR com parte CANCELADA e escopo inerte', { EVENTO: 'pull_request', REF: 'x', ESCOPO_DOCS: '' }, needs({ result: 'success', roda: 'false', modo: 'inerte' }, 'cancelled')],
    ['dispatch com base curta', MAIN, needs({ result: 'success', roda: 'false', base: A.slice(1), modo: 'main-docs' })],
    ['dispatch com base em caixa alta', MAIN, needs({ result: 'success', roda: 'false', base: A.toUpperCase(), modo: 'main-docs' })],
    ['dispatch com base e lixo', MAIN, needs({ result: 'success', roda: 'false', base: `${A}\nx`, modo: 'main-docs' })],
    ['push forjando o pulo', { ...MAIN, EVENTO: 'push' }, PULOU_MAIN],
    ['schedule forjando o pulo', { ...MAIN, EVENTO: 'schedule' }, PULOU_MAIN],
    ['escopo failure', MAIN, needs({ result: 'failure', roda: 'false', base: A, modo: 'main-docs' })],
    ['escopo cancelled', MAIN, needs({ result: 'cancelled', roda: 'false', base: A, modo: 'main-docs' })],
    ['roda=true com provas puladas', MAIN, needs({ result: 'success', roda: 'true', base: A, modo: 'main-docs' })],
    ['roda=FALSE', MAIN, needs({ result: 'success', roda: 'FALSE', base: A, modo: 'main-docs' })],
    ['saída vazia', MAIN, needs({ result: 'success' })],
    ['PR com escopo failure', { EVENTO: 'pull_request', REF: 'x', ESCOPO_DOCS: '' }, needs({ result: 'failure', roda: 'false', modo: 'inerte' })],
  ] as [string, Record<string, string>, string][])('%s reprova', (_n, env, resultados) => {
    expect(roda({ ...env, RESULTADOS: resultados })).toBe(1);
  });

  // `gh` FALSO no PATH: devolve o run e os jobs de `fixtures/<id>.run|.jobs` (ausente ⇒ exit 1, como
  // um 404). Assim o validate é exercitado sem rede, e a revalidação do recibo tem de ACONTECER.
  function ghFalso(runs: Record<string, { run: unknown; jobs: unknown }>): { path: string; limpa: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'gh-falso-'));
    for (const [id, f] of Object.entries(runs)) {
      writeFileSync(join(dir, `${id}.run`), JSON.stringify(f.run));
      writeFileSync(join(dir, `${id}.jobs`), JSON.stringify(f.jobs));
    }
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        '[ "$1" = api ] || exit 2',
        `d='${dir}'`,
        'if [[ "$2" =~ ^repos/[^/]+/[^/]+/actions/runs/([0-9]+)/jobs ]]; then f="$d/${BASH_REMATCH[1]}.jobs";',
        'elif [[ "$2" =~ ^repos/[^/]+/[^/]+/actions/runs/([0-9]+)$ ]]; then f="$d/${BASH_REMATCH[1]}.run"; else exit 3; fi',
        '[ -f "$f" ] || { echo "HTTP 404" >&2; exit 1; }',
        'cat "$f"',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { path: `${dir}:${process.env.PATH ?? ''}`, limpa: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const PR_ENV = { EVENTO: 'pull_request', REF: 'refs/pull/7/merge', ESCOPO_DOCS: '', REPO: 'o/r', RUN_ID: '900', HEAD_REF: 'claude/x' };
  const runOk = { id: 800, event: 'pull_request', status: 'completed', head_branch: 'claude/x', head_repository: { full_name: 'o/r' } };
  const jobsOk = {
    total_count: 7,
    jobs: [...[1, 2, 3, 4, 5].map((k) => ({ name: `provas-sql (${k})`, conclusion: 'success' })), { name: 'provas-sql-uniao', conclusion: 'success' }, { name: 'validate', conclusion: 'success' }],
  };
  const REAPROVEITOU = needs({ result: 'success', roda: 'false', modo: 'recibo', recibo: '800' });

  it.skipIf(!temJq)('controle: recibo deste PR com partes e união success passa — e a API é CONSULTADA', () => {
    const gh = ghFalso({ '800': { run: runOk, jobs: jobsOk } });
    try {
      expect(roda({ ...PR_ENV, RESULTADOS: REAPROVEITOU }, gh.path)).toBe(0);
      // Sem o run na API (recibo inexistente), o mesmo cenário reprova: a aprovação veio da leitura.
      const vazio = ghFalso({});
      try {
        expect(roda({ ...PR_ENV, RESULTADOS: REAPROVEITOU }, vazio.path)).toBe(1);
      } finally {
        vazio.limpa();
      }
    } finally {
      gh.limpa();
    }
  });

  it.skipIf(!temJq).each([
    ['recibo de OUTRO PR (outra branch)', { '800': { run: { ...runOk, head_branch: 'claude/outro' }, jobs: jobsOk } }, REAPROVEITOU, PR_ENV],
    ['recibo de fork (outro repo)', { '800': { run: { ...runOk, head_repository: { full_name: 'fork/r' } }, jobs: jobsOk } }, REAPROVEITOU, PR_ENV],
    ['recibo de run da main', { '800': { run: { ...runOk, event: 'workflow_dispatch' }, jobs: jobsOk } }, REAPROVEITOU, PR_ENV],
    ['recibo não concluído', { '800': { run: { ...runOk, status: 'in_progress' }, jobs: jobsOk } }, REAPROVEITOU, PR_ENV],
    ['recibo com parte CANCELADA', { '800': { run: runOk, jobs: { ...jobsOk, jobs: jobsOk.jobs.map((j, i) => (i === 2 ? { ...j, conclusion: 'cancelled' } : j)) } } }, REAPROVEITOU, PR_ENV],
    ['recibo com união skipped', { '800': { run: runOk, jobs: { ...jobsOk, jobs: jobsOk.jobs.map((j) => (j.name === 'provas-sql-uniao' ? { ...j, conclusion: 'skipped' } : j)) } } }, REAPROVEITOU, PR_ENV],
    ['recibo sem partes', { '800': { run: runOk, jobs: { total_count: 1, jobs: [{ name: 'provas-sql-uniao', conclusion: 'success' }] } } }, REAPROVEITOU, PR_ENV],
    ['recibo com página incompleta', { '800': { run: runOk, jobs: { ...jobsOk, total_count: 99 } } }, REAPROVEITOU, PR_ENV],
    ['recibo INEXISTENTE (404)', {}, REAPROVEITOU, PR_ENV],
    ['recibo é o próprio run', { '900': { run: { ...runOk, id: 900 }, jobs: jobsOk } }, needs({ result: 'success', roda: 'false', modo: 'recibo', recibo: '900' }), PR_ENV],
    ['recibo vazio', { '800': { run: runOk, jobs: jobsOk } }, needs({ result: 'success', roda: 'false', modo: 'recibo' }), PR_ENV],
    ['recibo com lixo', { '800': { run: runOk, jobs: jobsOk } }, needs({ result: 'success', roda: 'false', modo: 'recibo', recibo: '800 x' }), PR_ENV],
    ['recibo fora de PR', { '800': { run: runOk, jobs: jobsOk } }, REAPROVEITOU, { ...PR_ENV, ...MAIN }],
    ['recibo sem HEAD_REF', { '800': { run: { ...runOk, head_branch: '' }, jobs: jobsOk } }, REAPROVEITOU, { ...PR_ENV, HEAD_REF: '' }],
    ['recibo com partes que RODARAM aqui canceladas', { '800': { run: runOk, jobs: jobsOk } }, needs({ result: 'success', roda: 'false', modo: 'recibo', recibo: '800' }, 'cancelled'), PR_ENV],
  ] as [string, Record<string, { run: unknown; jobs: unknown }>, string, Record<string, string>][])('%s reprova', (_n, api, resultados, env) => {
    const gh = ghFalso(api);
    try {
      expect(roda({ ...env, RESULTADOS: resultados }, gh.path)).toBe(1);
    } finally {
      gh.limpa();
    }
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

// ─── Recibo do MESMO PR (fatia C) ───────────────────────────────────────────────────────────────
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const T = 'e'.repeat(40);
const F = 'f'.repeat(40);

describe('provas-sql-escopo — mergeDaAnotacao (o merge que o recibo testou)', () => {
  const ok = { title: TITULO_RECIBO, message: `pr=7 base=${A} head=${B} tree=${T}` };
  it('controle: a anotação que o próprio script emite é lida de volta', () => {
    expect(anotacaoRecibo(7, { base: A, head: B, tree: T })).toBe(`::notice title=${TITULO_RECIBO}::pr=7 base=${A} head=${B} tree=${T}`);
    expect(mergeDaAnotacao([{ title: 'outra', message: 'x' }, ok], 7, B)).toEqual({ base: A, head: B, tree: T });
  });
  it.each([
    ['de OUTRO PR', [ok], 8, B],
    ['head diferente do head_sha do run', [ok], 7, C],
    ['duas anotações', [ok, ok], 7, B],
    ['nenhuma', [{ title: 'outra', message: ok.message }], 7, B],
    ['sem tree', [{ ...ok, message: `pr=7 base=${A} head=${B}` }], 7, B],
    ['com lixo no fim', [{ ...ok, message: `${ok.message} x` }], 7, B],
    ['corpo não-lista', { message: ok.message }, 7, B],
  ] as [string, unknown, number, string][])('%s ⇒ null', (_n, corpo, pr, head) => {
    expect(mergeDaAnotacao(corpo, pr, head)).toBeNull();
  });
  it('rota do check-run vem da URL da API, nunca do id do job', () => {
    expect(rotaDoCheckRun({ id: 1, name: 'x', conclusion: 'success', check_run_url: 'https://api.github.com/repos/o/r/check-runs/55' })).toBe('repos/o/r/check-runs/55');
    expect(() => rotaDoCheckRun({ id: 1, name: 'x', conclusion: 'success' })).toThrow(/check_run_url fora de forma/);
    expect(() => rotaDoCheckRun({ id: 1, name: 'x', conclusion: 'success', check_run_url: 'https://evil/repos/o/r/check-runs/55' })).toThrow(/check_run_url fora de forma/);
  });
});

describe('provas-sql-escopo — escolherRecibo', () => {
  const run = (id: number, over: Partial<RunDoPr> = {}): RunDoPr => ({
    id, event: 'pull_request', status: 'completed', head_sha: B, head_branch: 'claude/x', repo: 'o/r', ...over,
  });
  const verde: JobComId[] = [...VERDE.map((j, i) => ({ ...j, id: i + 1 })), { name: 'provas-sql-escopo', conclusion: 'success', id: 99 }];
  const pulado: JobComId[] = [{ name: 'provas-sql (1)', conclusion: 'skipped', id: 1 }, { name: 'provas-sql-uniao', conclusion: 'skipped', id: 2 }];
  const vermelho: JobComId[] = verde.map((j) => (j.name === 'provas-sql (3)' ? { ...j, conclusion: 'failure' } : j));
  const cancelado: JobComId[] = verde.map((j) => (j.name === 'provas-sql (3)' ? { ...j, conclusion: 'cancelled' } : j));
  const de = (m: Record<number, JobComId[] | null>) => (id: number) => (id in m ? m[id] : null);

  it('controle: atravessa o run pulado e acha o verde', () => {
    const r = escolherRecibo([run(5), run(4), run(3)], 5, 'o/r', 'claude/x', de({ 4: pulado, 3: verde }));
    expect('run' in r && r.run.id).toBe(3);
  });
  it.each([
    ['o mais recente que executou ficou VERMELHO (não atravessa até o verde velho)', de({ 4: vermelho, 3: verde })],
    ['o mais recente que executou foi CANCELADO (fail-fast ou superado)', de({ 4: cancelado, 3: verde })],
    ['jobs ilegíveis', de({ 4: null, 3: verde })],
  ])('%s ⇒ sem recibo', (_n, jobsDe) => {
    expect('motivo' in escolherRecibo([run(5), run(4), run(3)], 5, 'o/r', 'claude/x', jobsDe)).toBe(true);
  });
  it.each([
    ['de OUTRA branch (outro PR)', run(3, { head_branch: 'claude/outro' })],
    ['de fork', run(3, { repo: 'fork/r' })],
    ['da main', run(3, { event: 'workflow_dispatch' })],
    ['não concluído', run(3, { status: 'in_progress' })],
    ['o próprio run', run(5)],
    ['SHA inválido', run(3, { head_sha: 'xyz' })],
  ])('run %s nunca é recibo', (_n, r) => {
    expect('motivo' in escolherRecibo([r], 5, 'o/r', 'claude/x', de({ 3: verde, 5: verde }))).toBe(true);
  });
  it('SHA verde INEXISTENTE (nenhum run anterior) ⇒ sem recibo', () => {
    expect('motivo' in escolherRecibo([], 5, 'o/r', 'claude/x', de({}))).toBe(true);
  });
});

describe('provas-sql-escopo — decidirRecibo', () => {
  const LIDOS = new Set(['src/lib/lido.ts']);
  const ok: FatosRecibo = {
    atual: { base: C, head: D, tree: F },
    recibo: { runId: 3, merge: { base: A, head: B, tree: T } },
    headAncestral: true,
    baseAncestral: true,
    merges: 0,
    forkRecibo: A,
    forkAtual: A,
    arvoreRecalculada: T,
    diffHead: ['docs/historico/x.md'],
    diffArvore: [{ caminho: 'docs/historico/x.md', especial: false }, { caminho: 'src/pages/Tela.tsx', especial: false }],
    lidos: LIDOS,
  };
  it('controle: só docs/inerte desde a árvore provada ⇒ REAPROVEITA, com o id do run', () => {
    const d = decidirRecibo(ok);
    expect(d.roda).toBe(false);
    expect(d.recibo).toBe(3);
  });
  it.each([
    ['sem recibo (SHA verde inexistente)', { recibo: { motivo: 'nenhum run' } }],
    ['1 arquivo SQL no meio de docs (árvore)', { diffArvore: [...ok.diffArvore!, { caminho: 'supabase/migrations/x.sql', especial: false }] }],
    ['1 arquivo de db/ no meio de docs (head)', { diffHead: ['docs/a.md', 'db/test-x.sh', 'docs/b.md'] }],
    ['código lido pelas provas no meio de docs', { diffArvore: [...ok.diffArvore!, { caminho: 'src/lib/lido.ts', especial: false }] }],
    ['scripts/ no meio de docs', { diffHead: ['docs/a.md', 'scripts/x.ts'] }],
    ['.gitattributes dentro de src/', { diffArvore: [...ok.diffArvore!, { caminho: 'src/.gitattributes', especial: false }] }],
    ['symlink no diff', { diffArvore: [{ caminho: 'docs/link', especial: true }] }],
    ['drift da main com código', { diffArvore: [...ok.diffArvore!, { caminho: 'package.json', especial: false }] }],
    ['merge da main no PR (merge commit)', { merges: 1 }],
    ['merges ilegíveis', { merges: null }],
    ['rebase (head do recibo não é ancestral)', { headAncestral: false }],
    ['ancestralidade do head inconclusiva', { headAncestral: null }],
    ['OUTRA base: a base do recibo não é ancestral', { baseAncestral: false }],
    ['OUTRA base: merge-base com a main mudou', { forkAtual: C }],
    ['merge-base ilegível', { forkRecibo: null }],
    ['árvore recalculada ≠ registrada', { arvoreRecalculada: F }],
    ['árvore recalculada com conflito', { arvoreRecalculada: null }],
    ['re-run do MESMO head', { atual: { base: C, head: B, tree: F } }],
    ['diff vazio', { diffArvore: [] }],
    ['diff do head vazio', { diffHead: [] }],
    ['diff ilegível', { diffArvore: null }],
    ['mapa de leitura ilegível', { lidos: null }],
    ['SHA fora de forma', { atual: { base: 'x', head: D, tree: F } }],
  ] as [string, Partial<FatosRecibo>][])('%s ⇒ roda TUDO', (_n, mudanca) => {
    const d = decidirRecibo({ ...ok, ...mudanca });
    expect(d.roda).toBe(true);
    expect(d.recibo).toBeUndefined();
  });
});

describe('provas-sql-escopo — mapa de leitura incompleto e .gitattributes', () => {
  it('arquivo de db/ que não se lê ⇒ mapa null (roda), não "não lê nada"', () => {
    const repo: Repo = { arquivos: ['db/test-a.sh'], ler: () => null, existe: () => true };
    expect(lidosEmInerte(repo)).toBeNull();
    expect(decidir('pull_request', ['docs/x.md'], lidosEmInerte(repo)).roda).toBe(true);
  });
  it('symlink de db/ para src/ registra o alvo como lido', () => {
    const repo: Repo = { ...repoFalso({ 'db/link.sh': 'echo', 'src/alvo.sh': 'echo' }), alvo: (p) => (p === 'db/link.sh' ? 'src/alvo.sh' : null) };
    expect(inerte('src/alvo.sh', lidosDe(repo))).toBe(false);
    expect(inerte('src/outro.ts', lidosDe(repo))).toBe(true);
  });
  it('.gitattributes em qualquer diretório nunca é inerte', () => {
    expect(inerte('src/.gitattributes', NENHUM)).toBe(false);
    expect(inerte('docs/.gitattributes', NENHUM)).toBe(false);
    expect(inerte('docs/gitattributes.md', NENHUM)).toBe(true);
  });
});

// Git REAL: main + PR, o merge commit que o GitHub testaria (`merge --no-ff`), e os pushes seguintes.
describe('provas-sql-escopo — recibo com git real', () => {
  function cenario() {
    const dir = mkdtempSync(join(tmpdir(), 'escopo-recibo-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    const escreve = (f: string, t: string) => {
      execFileSync('mkdir', ['-p', join(dir, f, '..')]);
      writeFileSync(join(dir, f), t);
      git('add', f);
    };
    git('init', '-q', '-b', 'main');
    escreve('db/test-a.sh', 'cat src/lib/lido.ts\n');
    escreve('src/lib/lido.ts', 'export const x = 1;\n');
    escreve('docs/a.md', 'a\n');
    git('commit', '-qm', 'raiz');
    git('checkout', '-qb', 'pr');
    escreve('supabase/migrations/1.sql', 'select 1;\n');
    git('commit', '-qm', 'pr: sql');
    /** O merge commit que o CI testa: main + head do PR, sem mexer nas branches. */
    const testa = (): { base: string; head: string; tree: string } => {
      const head = git('rev-parse', 'pr');
      git('checkout', '-q', '--detach', 'main');
      git('merge', '-q', '--no-ff', '--no-edit', head);
      const m = mergeDoCheckout(dir)!;
      git('checkout', '-q', 'pr');
      return m;
    };
    const naMain = (f: string, t: string) => {
      git('checkout', '-q', 'main');
      escreve(f, t);
      git('commit', '-qm', `main: ${f}`);
      git('checkout', '-q', 'pr');
    };
    const noPr = (f: string, t: string) => {
      escreve(f, t);
      git('commit', '-qm', `pr: ${f}`);
    };
    const lidos = new Set(['src/lib/lido.ts']);
    const decide = (m1: ReturnType<typeof testa>, m2: ReturnType<typeof testa>) =>
      decidirRecibo(fatosGitDoRecibo(m2, { runId: 3, merge: m1 }, lidos, dir));
    return { dir, git, testa, naMain, noPr, decide, limpa: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('controle: push só de docs, e a main andou só em docs ⇒ REAPROVEITA', () => {
    const c = cenario();
    try {
      const m1 = c.testa();
      c.noPr('docs/b.md', 'b\n');
      c.naMain('docs/c.md', 'c\n');
      const d = c.decide(m1, c.testa());
      expect(d.motivos.join(' ')).toContain('REAPROVEITA');
      expect(d.roda).toBe(false);
    } finally {
      c.limpa();
    }
  });
  it.each([
    ['1 arquivo SQL no meio de docs', (c: ReturnType<typeof cenario>) => { c.noPr('docs/b.md', 'b\n'); c.noPr('supabase/migrations/2.sql', 'select 2;\n'); c.noPr('docs/d.md', 'd\n'); }],
    ['código lido pelas provas no meio de docs', (c: ReturnType<typeof cenario>) => { c.noPr('docs/b.md', 'b\n'); c.noPr('src/lib/lido.ts', 'export const x = 2;\n'); }],
    ['a main mudou código (drift não-inerte)', (c: ReturnType<typeof cenario>) => { c.noPr('docs/b.md', 'b\n'); c.naMain('db/test-a.sh', 'cat src/lib/lido.ts # v2\n'); }],
    ['merge da main no PR', (c: ReturnType<typeof cenario>) => { c.naMain('docs/c.md', 'c\n'); c.git('merge', '-q', '--no-ff', '--no-edit', 'main'); c.noPr('docs/b.md', 'b\n'); }],
    ['rebase do PR sobre a main', (c: ReturnType<typeof cenario>) => { c.naMain('docs/c.md', 'c\n'); c.git('rebase', '-q', 'main'); c.noPr('docs/b.md', 'b\n'); }],
  ])('%s ⇒ roda TUDO', (_n, depois) => {
    const c = cenario();
    try {
      const m1 = c.testa();
      depois(c);
      const d = c.decide(m1, c.testa());
      expect(d.roda).toBe(true);
      expect(d.recibo).toBeUndefined();
    } finally {
      c.limpa();
    }
  });
  it('recibo de OUTRO PR (outra história) ⇒ roda TUDO', () => {
    const c = cenario();
    try {
      c.git('checkout', '-qb', 'outro', 'main');
      c.noPr('supabase/migrations/9.sql', 'select 9;\n');
      c.git('branch', '-f', 'pr', 'outro');
      const doOutro = c.testa();
      c.git('checkout', '-q', '-B', 'pr', 'main');
      c.noPr('supabase/migrations/1.sql', 'select 1;\n');
      c.noPr('docs/b.md', 'b\n');
      expect(c.decide(doOutro, c.testa()).roda).toBe(true);
    } finally {
      c.limpa();
    }
  });
});
