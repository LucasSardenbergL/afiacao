import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARQ_MAPA } from './sonda-fingerprint';
import {
  calcularFanOut,
  coletarFanOut,
  contaComoShared,
  main,
  renderizar,
  type EdgeNaFatia,
  type Relatorio,
} from './sonda-fan-out';

const SHARED = 'supabase/functions/_shared';

/** Uma edge do núcleo puro com o mínimo de ruído. */
function edge(p: Partial<EdgeNaFatia> & { edge: string }): EdgeNaFatia {
  return {
    fecho: [`supabase/functions/${p.edge}/index.ts`],
    erroFecho: null,
    versaoBase: 'v1.0-inicial',
    versaoHead: 'v1.0-inicial',
    ...p,
  };
}

const mudou = (caminho: string, removido = false) => ({ caminho, removido });

describe('contaComoShared — o que conta como "arquivo de _shared/ que muda o fonte"', () => {
  it('conta um helper de _shared/', () => {
    expect(contaComoShared(`${SHARED}/auth.ts`)).toBe(true);
  });

  it('NAO conta teste — nunca entra em fecho nenhum (o fingerprint o exclui)', () => {
    expect(contaComoShared(`${SHARED}/auth_test.ts`)).toBe(false);
    expect(contaComoShared(`${SHARED}/auth.test.ts`)).toBe(false);
  });

  it('NAO conta o mapa gerado — ele e a SAIDA, muda em toda fatia que muda qualquer coisa', () => {
    expect(contaComoShared(ARQ_MAPA)).toBe(false);
  });

  it('NAO conta arquivo da pasta de uma edge (isso e territorio do sonda:bump)', () => {
    expect(contaComoShared('supabase/functions/recommend/index.ts')).toBe(false);
  });

  it('fronteira e de SEGMENTO — `_shared-x/` nao e `_shared/`', () => {
    expect(contaComoShared('supabase/functions/_shared-x/auth.ts')).toBe(false);
  });
});

describe('calcularFanOut — o caso que motivou o sinal', () => {
  it('#2132 em miniatura: um _shared/ muda, quem bumpou e BUMP, quem nao bumpou e SEM_BUMP, quem nao importa some', () => {
    const rel = calcularFanOut(
      [mudou(`${SHARED}/leitura-critica.ts`)],
      [
        edge({
          edge: 'fin-valor-cockpit',
          fecho: ['supabase/functions/fin-valor-cockpit/index.ts', `${SHARED}/leitura-critica.ts`],
          versaoBase: 'v1.2-a',
          versaoHead: 'v1.3-b',
        }),
        edge({
          edge: 'ai-ops-agent',
          fecho: ['supabase/functions/ai-ops-agent/index.ts', `${SHARED}/leitura-critica.ts`],
        }),
        edge({ edge: 'edge-isolada' }),
      ],
    );
    expect(rel.arquivos).toEqual([
      { caminho: `${SHARED}/leitura-critica.ts`, removido: false, consumidoras: ['ai-ops-agent', 'fin-valor-cockpit'] },
    ]);
    expect(rel.edges).toEqual([
      {
        edge: 'ai-ops-agent',
        status: 'SEM_BUMP',
        versaoBase: 'v1.0-inicial',
        versaoHead: 'v1.0-inicial',
        causas: [`${SHARED}/leitura-critica.ts`],
      },
      {
        edge: 'fin-valor-cockpit',
        status: 'BUMP',
        versaoBase: 'v1.2-a',
        versaoHead: 'v1.3-b',
        causas: [`${SHARED}/leitura-critica.ts`],
      },
    ]);
    expect(rel.avisos).toEqual([]);
  });

  it('edge afetada por DOIS arquivos sai em UMA linha, com as duas causas ordenadas', () => {
    const rel = calcularFanOut(
      [mudou(`${SHARED}/b.ts`), mudou(`${SHARED}/a.ts`)],
      [edge({ edge: 'e', fecho: ['supabase/functions/e/index.ts', `${SHARED}/a.ts`, `${SHARED}/b.ts`] })],
    );
    expect(rel.edges).toHaveLength(1);
    expect(rel.edges[0].causas).toEqual([`${SHARED}/a.ts`, `${SHARED}/b.ts`]);
    expect(rel.arquivos.map((a) => a.caminho)).toEqual([`${SHARED}/a.ts`, `${SHARED}/b.ts`]);
  });

  it('edge que NASCE instrumentada nesta fatia e NOVA — o marcador inicial ja nomeia a fatia', () => {
    const rel = calcularFanOut(
      [mudou(`${SHARED}/a.ts`)],
      [edge({ edge: 'nova', fecho: [`${SHARED}/a.ts`], versaoBase: null, versaoHead: 'v1.0-sensor-inicial' })],
    );
    expect(rel.edges[0].status).toBe('NOVA');
  });

  it('VERSAO ilegivel no HEAD e ILEGIVEL — sem marcador legivel a sonda nao prova bundle nenhum', () => {
    const rel = calcularFanOut(
      [mudou(`${SHARED}/a.ts`)],
      [edge({ edge: 'e', fecho: [`${SHARED}/a.ts`], versaoHead: null })],
    );
    expect(rel.edges[0].status).toBe('ILEGIVEL');
  });

  it('ILEGIVEL vence NOVA: nascer sem marcador legivel nao e nascer instrumentada', () => {
    const rel = calcularFanOut(
      [mudou(`${SHARED}/a.ts`)],
      [edge({ edge: 'e', fecho: [`${SHARED}/a.ts`], versaoBase: null, versaoHead: null })],
    );
    expect(rel.edges[0].status).toBe('ILEGIVEL');
  });
});

describe('calcularFanOut — o RUIDO que treinaria a ignorar', () => {
  it('teste de _shared/ alterado nao gera linha nenhuma (a regra mora no nucleo, nao so no coletor)', () => {
    const rel = calcularFanOut(
      [mudou(`${SHARED}/a_test.ts`)],
      [edge({ edge: 'e', fecho: [`${SHARED}/a_test.ts`, `${SHARED}/a.ts`] })],
    );
    expect(rel.arquivos).toEqual([]);
    expect(rel.edges).toEqual([]);
  });

  it('o mapa gerado alterado nao gera linha nenhuma', () => {
    const rel = calcularFanOut([mudou(ARQ_MAPA)], [edge({ edge: 'e', fecho: [ARQ_MAPA] })]);
    expect(rel.arquivos).toEqual([]);
    expect(rel.edges).toEqual([]);
  });

  it('arquivo de _shared/ que ninguem importa sai com consumidoras=0 e sem linha de edge', () => {
    const rel = calcularFanOut([mudou(`${SHARED}/orfao.ts`)], [edge({ edge: 'e' })]);
    expect(rel.arquivos).toEqual([{ caminho: `${SHARED}/orfao.ts`, removido: false, consumidoras: [] }]);
    expect(rel.edges).toEqual([]);
  });

  it('arquivo REMOVIDO e marcado como tal — "fora de todo fecho" seria a explicacao errada', () => {
    const rel = calcularFanOut([mudou(`${SHARED}/velho.ts`, true)], [edge({ edge: 'e' })]);
    expect(rel.arquivos[0].removido).toBe(true);
  });

  it('nada alterado em _shared/ ⇒ relatorio vazio, sem aviso', () => {
    const rel = calcularFanOut([], [edge({ edge: 'e', fecho: [`${SHARED}/a.ts`] })]);
    expect(rel).toEqual({ arquivos: [], edges: [], avisos: [] });
  });
});

describe('calcularFanOut — fecho ilegivel', () => {
  it('edge cujo fecho nao fecha vira AVISO nomeando a edge, e nao linha de edge (o fingerprint ja reprova esse caso)', () => {
    const rel = calcularFanOut(
      [mudou(`${SHARED}/a.ts`)],
      [edge({ edge: 'quebrada', fecho: null, erroFecho: 'import local que NAO resolve: x.ts' })],
    );
    expect(rel.edges).toEqual([]);
    expect(rel.avisos).toHaveLength(1);
    expect(rel.avisos[0]).toContain('quebrada');
    expect(rel.avisos[0]).toContain('x.ts');
  });
});

describe('renderizar — uma linha por edge, ASCII, caixa fixa', () => {
  const relatorio: Relatorio = {
    arquivos: [
      { caminho: `${SHARED}/a.ts`, removido: false, consumidoras: ['e-bump', 'e-sem'] },
      { caminho: `${SHARED}/orfao.ts`, removido: false, consumidoras: [] },
      { caminho: `${SHARED}/velho.ts`, removido: true, consumidoras: [] },
    ],
    edges: [
      { edge: 'e-bump', status: 'BUMP', versaoBase: 'v1.0-a', versaoHead: 'v1.1-b', causas: [`${SHARED}/a.ts`] },
      { edge: 'e-ileg', status: 'ILEGIVEL', versaoBase: 'v1.0-a', versaoHead: null, causas: [`${SHARED}/a.ts`] },
      { edge: 'e-nova', status: 'NOVA', versaoBase: null, versaoHead: 'v1.0-x', causas: [`${SHARED}/a.ts`] },
      { edge: 'e-sem', status: 'SEM_BUMP', versaoBase: 'v1.0-a', versaoHead: 'v1.0-a', causas: [`${SHARED}/a.ts`] },
    ],
    avisos: [],
  };

  it('toda linha e ASCII imprimivel — sem acento, sem seta, sem check', () => {
    for (const l of renderizar(relatorio, 'abc1234..HEAD')) {
      expect(l).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('ha exatamente UMA linha por edge, comecando pelo status em caixa alta', () => {
    const linhas = renderizar(relatorio, 'abc1234..HEAD');
    const deEdge = linhas.filter((l) => /^\s+(BUMP|SEM_BUMP|NOVA|ILEGIVEL)\s+e-/.test(l));
    expect(deEdge).toHaveLength(4);
    expect(deEdge.filter((l) => /^\s+SEM_BUMP\s+e-sem\b/.test(l))).toHaveLength(1);
    expect(deEdge.filter((l) => /^\s+BUMP\s+e-bump\b/.test(l))).toHaveLength(1);
  });

  it('a linha da edge traz as versoes e a causa; a de arquivo traz a contagem de consumidoras', () => {
    const texto = renderizar(relatorio, 'abc1234..HEAD').join('\n');
    expect(texto).toMatch(/BUMP\s+e-bump\s+v1\.0-a -> v1\.1-b.*_shared\/a\.ts/);
    expect(texto).toMatch(/SEM_BUMP\s+e-sem\s+v1\.0-a/);
    expect(texto).toMatch(/_shared\/a\.ts\s+consumidoras=2: e-bump,e-sem/);
    expect(texto).toMatch(/_shared\/orfao\.ts\s+consumidoras=0/);
    expect(texto).toMatch(/_shared\/velho\.ts\s+.*removido/);
  });

  it('o resumo conta por status e nomeia P1/P2 — e o que o autor le para decidir', () => {
    const texto = renderizar(relatorio, 'abc1234..HEAD').join('\n');
    expect(texto).toMatch(/BUMP=1\b/);
    expect(texto).toMatch(/SEM_BUMP=1\b/);
    expect(texto).toMatch(/NOVA=1\b/);
    expect(texto).toMatch(/ILEGIVEL=1\b/);
    expect(texto).toContain('P1');
    expect(texto).toContain('DIVERGE_P2');
  });

  it('relatorio vazio vira UMA linha dizendo que nada de _shared/ mudou — ausencia dita, nao silencio', () => {
    const linhas = renderizar({ arquivos: [], edges: [], avisos: [] }, 'abc1234..HEAD');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain('nenhum arquivo de _shared/');
    expect(linhas[0]).toContain('abc1234..HEAD');
  });
});

// ─── I/O: fixture git em tmpdir ──────────────────────────────────────────────────────────────

/**
 * Repo git DE MENTIRA num tmpdir, com base commitada e HEAD na arvore de trabalho ou commitado.
 * Nao usa o repo real de proposito: um teste que le a arvore real mede o que ALGUEM ACABOU DE
 * MUDAR, nao a regua (mesma doutrina do `sonda-fingerprint.test.ts`).
 */
let raiz: string;

function gitF(...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', raiz, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8' },
  ).trim();
}

function escrever(rel: string, conteudo: string): void {
  const abs = join(raiz, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, conteudo, 'utf8');
}

function montarEdge(nome: string, imports: string[], versao = 'v1.0-inicial'): void {
  escrever(
    `supabase/functions/${nome}/index.ts`,
    imports.map((i) => `import "${i}";\n`).join('') + `export default {};\n`,
  );
  escrever(`supabase/functions/${nome}/versao.ts`, `export const VERSAO = "${versao}";\n`);
}

/** Base: dois helpers em _shared/, edge-a e edge-b importam auth, edge-c so o proprio util. */
function montarBase(): string {
  gitF('init', '-q', '-b', 'main');
  escrever(`${SHARED}/auth.ts`, `export const auth = "v1";\n`);
  escrever(`${SHARED}/cors.ts`, `export const cors = "v1";\n`);
  escrever(`${SHARED}/auth_test.ts`, `// teste\n`);
  montarEdge('edge-a', ['../_shared/auth.ts']);
  montarEdge('edge-b', ['../_shared/auth.ts', '../_shared/cors.ts']);
  montarEdge('edge-c', ['./util.ts']);
  escrever('supabase/functions/edge-c/util.ts', `export const u = 1;\n`);
  gitF('add', '-A');
  gitF('commit', '-q', '-m', 'base');
  return gitF('rev-parse', 'HEAD');
}

/** A fatia: auth muda, edge-a bumpa, edge-b nao. */
function aplicarFatia(): void {
  escrever(`${SHARED}/auth.ts`, `export const auth = "v2";\n`);
  escrever('supabase/functions/edge-a/versao.ts', `export const VERSAO = "v1.1-auth-v2";\n`);
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'sonda-fan-out-'));
});
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

describe('coletarFanOut — a fatia real, medida com git', () => {
  it('base commitada vs ARVORE DE TRABALHO: le o diff, os fechos e os VERSAO dos dois lados', () => {
    const base = montarBase();
    aplicarFatia();
    const { alterados, edges } = coletarFanOut(raiz, base, null);
    expect(alterados).toEqual([{ caminho: `${SHARED}/auth.ts`, removido: false }]);
    const porNome = Object.fromEntries(edges.map((e) => [e.edge, e]));
    expect(porNome['edge-a'].versaoBase).toBe('v1.0-inicial');
    expect(porNome['edge-a'].versaoHead).toBe('v1.1-auth-v2');
    expect(porNome['edge-b'].versaoHead).toBe('v1.0-inicial');
    expect(porNome['edge-a'].fecho).toContain(`${SHARED}/auth.ts`);
    expect(porNome['edge-c'].fecho).not.toContain(`${SHARED}/auth.ts`);
  });

  it('ponta a ponta: o relatorio da fatia da BUMP para edge-a e SEM_BUMP para edge-b; edge-c fica fora', () => {
    const base = montarBase();
    aplicarFatia();
    const { alterados, edges } = coletarFanOut(raiz, base, null);
    const rel = calcularFanOut(alterados, edges);
    expect(rel.edges.map((e) => `${e.status} ${e.edge}`)).toEqual(['BUMP edge-a', 'SEM_BUMP edge-b']);
    expect(rel.arquivos[0].consumidoras).toEqual(['edge-a', 'edge-b']);
  });

  it('com --head <rev>, le a REV e nao a arvore de trabalho', () => {
    const base = montarBase();
    aplicarFatia();
    gitF('add', '-A');
    gitF('commit', '-q', '-m', 'fatia');
    const head = gitF('rev-parse', 'HEAD');
    // Sabotagem da arvore DEPOIS do commit — tres eixos, um por leitura que o coletor faz:
    //   diff   → cors.ts muda na arvore (entraria como 2o alterado);
    //   VERSAO → edge-b bumpa na arvore (viraria BUMP);
    //   fecho  → edge-c passa a importar auth na arvore (viraria consumidora).
    // Cada eixo so fica verde se o coletor ler a REV; qualquer um vermelho denuncia a arvore.
    escrever(`${SHARED}/cors.ts`, `export const cors = "sabotado";\n`);
    escrever('supabase/functions/edge-b/versao.ts', `export const VERSAO = "v9.9-sabotado";\n`);
    escrever('supabase/functions/edge-c/index.ts', `import "../_shared/auth.ts";\nexport default {};\n`);
    const { alterados, edges } = coletarFanOut(raiz, base, head);
    expect(alterados).toEqual([{ caminho: `${SHARED}/auth.ts`, removido: false }]);
    const porNome = Object.fromEntries(edges.map((e) => [e.edge, e]));
    expect(porNome['edge-b'].versaoHead).toBe('v1.0-inicial');
    expect(porNome['edge-c'].fecho).not.toContain(`${SHARED}/auth.ts`);
  });

  it('arquivo de _shared/ REMOVIDO sai como removido', () => {
    const base = montarBase();
    escrever('supabase/functions/edge-b/index.ts', `import "../_shared/auth.ts";\nexport default {};\n`);
    rmSync(join(raiz, `${SHARED}/cors.ts`));
    const { alterados } = coletarFanOut(raiz, base, null);
    expect(alterados).toEqual([{ caminho: `${SHARED}/cors.ts`, removido: true }]);
  });

  it('so teste de _shared/ mudou ⇒ nenhum alterado (e nada a atribuir)', () => {
    const base = montarBase();
    escrever(`${SHARED}/auth_test.ts`, `// outro teste\n`);
    const { alterados } = coletarFanOut(raiz, base, null);
    expect(alterados).toEqual([]);
  });

  it('fecho ilegivel numa edge NAO derruba a coleta: a edge vem com erroFecho, as outras medem', () => {
    const base = montarBase();
    aplicarFatia();
    montarEdge('edge-quebrada', ['../_shared/nao-existe.ts']);
    const { edges } = coletarFanOut(raiz, base, null);
    const q = edges.find((e) => e.edge === 'edge-quebrada');
    expect(q?.fecho).toBeNull();
    expect(q?.erroFecho).toMatch(/nao-existe/);
    expect(edges.find((e) => e.edge === 'edge-a')?.fecho).toContain(`${SHARED}/auth.ts`);
  });

  it('base que NAO resolve LANCA — lista vazia por erro nao pode virar "nada mudou"', () => {
    montarBase();
    expect(() => coletarFanOut(raiz, 'inexistente-xyz-000', null)).toThrow(/git/);
  });
});

describe('main — exit 0 com achados (informativo), 2 so por mecanica', () => {
  function capturar(argv: string[]): { rc: number; out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const s1 = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    const s2 = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
    try {
      return { rc: main(argv), out: out.join('\n'), err: err.join('\n') };
    } finally {
      s1.mockRestore();
      s2.mockRestore();
    }
  }

  it('na fixture: imprime SEM_BUMP para edge-b e BUMP para edge-a e sai 0 — achado nao e reprovacao', () => {
    const base = montarBase();
    aplicarFatia();
    const cwd0 = process.cwd();
    process.chdir(raiz);
    try {
      const { rc, out } = capturar(['--base', base]);
      expect(rc).toBe(0);
      expect(out).toMatch(/^\s+SEM_BUMP\s+edge-b\b/m);
      expect(out).toMatch(/^\s+BUMP\s+edge-a\b/m);
      expect(out).toMatch(/SEM_BUMP=1/);
    } finally {
      process.chdir(cwd0);
    }
  });

  it('fatia vazia (HEAD..HEAD no repo real) sai 0 dizendo que nada de _shared/ mudou', () => {
    const { rc, out } = capturar(['--base', 'HEAD', '--head', 'HEAD']);
    expect(rc).toBe(0);
    expect(out).toContain('nenhum arquivo de _shared/');
  });

  it('--base que nao resolve sai 2 NOMEANDO a base — nao medir nao e o mesmo que nada mudou', () => {
    const { rc, err } = capturar(['--base', 'inexistente-xyz-000']);
    expect(rc).toBe(2);
    expect(err).toMatch(/base/i);
  });

  it('--head que nao resolve sai 2 nomeando o --head', () => {
    const { rc, err } = capturar(['--base', 'HEAD', '--head', 'inexistente-xyz-000']);
    expect(rc).toBe(2);
    expect(err).toContain('--head');
  });
});
