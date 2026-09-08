import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  arvoreDaRef,
  type ExecutorGitBytes,
  fatiaDeDeploy,
  gitBytes,
  main,
  REF_DEPLOYADA,
  type SaidaGitBytes,
  sincronizarRef,
} from './pendencias-prompt';
import { sha256Arquivo } from './sonda-fingerprint';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Por que este arquivo existe
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// O núcleo puro (`lib/prompt-deploy.test.ts`) tem 35 testes verdes e NÃO alcança o defeito que
// mais dói aqui: ler a árvore ERRADA. Mesma lição do `sonda-versao-bump-gate` — "os dois
// falsos-verdes corrigidos aqui estavam ambos FORA do núcleo puro, que tinha 23 testes verdes".
// O eixo ÁRVORE só aparece na fronteira de I/O, então é aqui que ele se prova, com git de verdade.
//
// O repo é de MENTIRA, num tmpdir com um `origin` bare: um teste que lê a árvore real mede o que
// alguém acabou de mudar, não a régua (mesma doutrina do `sonda-fan-out.test.ts`).

const SHARED = 'supabase/functions/_shared';
const MAPA = `${SHARED}/sonda-fingerprints.ts`;

let raiz: string;
let remoto: string;

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

const sha256De = (texto: string): string => createHash('sha256').update(texto).digest('hex');

// ── O conteúdo COMMITADO (= o que `origin/main` tem, = o que o Lovable deploya) ───────────────
const INDEX_MAIN = `import "./a.ts";\nimport "../_shared/b.ts";\nexport default {};\n`;
const A_MAIN = `export const a = "main";\n`;
const B_MAIN = `export const b = "main";\n`;
const VERSAO_MAIN = `export const VERSAO = "v1.0-main";\n`;
const MAPA_MAIN = `export const FONTE_SHA256: Record<string, string> = {\n  "e": "${'0'.repeat(64)}",\n};\n`;

/** Repo local + `origin` bare, com a fatia da `edge-e` commitada e publicada. */
function montarRepo(): void {
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remoto]);
  gitF('init', '-q', '-b', 'main');
  gitF('remote', 'add', 'origin', remoto);
  escrever('supabase/functions/edge-e/index.ts', INDEX_MAIN);
  escrever('supabase/functions/edge-e/a.ts', A_MAIN);
  escrever('supabase/functions/edge-e/versao.ts', VERSAO_MAIN);
  escrever(`${SHARED}/b.ts`, B_MAIN);
  escrever(MAPA, MAPA_MAIN);
  gitF('add', '-A');
  gitF('commit', '-q', '-m', 'base');
  gitF('push', '-q', 'origin', 'main');
}

/**
 * O working tree DIVERGE da main, do jeito medido em 2026-09-04: o `index.ts` do disco importa
 * MENOS, e o arquivo que sumiu do import também sumiu do disco. Contra o disco o closure sai curto
 * e a função não bootaria; contra a ref ele sai inteiro.
 */
function divergirDoMain(): void {
  escrever('supabase/functions/edge-e/index.ts', `import "./a.ts";\nexport default {};\n`);
  escrever('supabase/functions/edge-e/a.ts', `export const a = "DISCO SUJO";\n`);
  unlinkSync(join(raiz, SHARED, 'b.ts'));
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'pendencias-prompt-'));
  raiz = join(base, 'local');
  remoto = join(base, 'remoto.git');
  mkdirSync(raiz, { recursive: true });
});
afterEach(() => rmSync(join(raiz, '..'), { recursive: true, force: true }));

// ═══════════════════════════════════════════════════════════════════════════════════════════
// O eixo ÁRVORE — o teste que fica VERMELHO se alguém trocar a ref pelo disco
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('fatiaDeDeploy lê a REF, não o working tree', () => {
  it('CONTROLE: com o disco IGUAL à main, a fatia é a esperada e os hashes batem', () => {
    montarRepo();
    const f = fatiaDeDeploy('edge-e', raiz, arvoreDaRef(REF_DEPLOYADA, gitBytes(raiz)));
    expect(f.arquivos.map((a) => a.caminho)).toEqual([
      `${SHARED}/b.ts`,
      MAPA,
      'supabase/functions/edge-e/a.ts',
      'supabase/functions/edge-e/index.ts',
    ]);
    const porCaminho = Object.fromEntries(f.arquivos.map((a) => [a.caminho, a.sha256]));
    expect(porCaminho[`${SHARED}/b.ts`]).toBe(sha256De(B_MAIN));
    expect(porCaminho['supabase/functions/edge-e/a.ts']).toBe(sha256De(A_MAIN));
  });

  it('FALSIFICAÇÃO (ÁRVORE): disco DIVERGENTE não muda nem a lista nem os hashes', () => {
    // Este é o teste que morre se `arvoreDaRef` virar `arvoreDeTrabalho`, ou se `fatiaDeDeploy`
    // voltar a `existsSync`/`readFileSync`. Contra o disco: 2 arquivos (`b.ts` sumiu do import E
    // do disco) e o hash de `a.ts` seria o do conteúdo sujo. Contra a ref: 4 arquivos e os hashes
    // da main. É o 5-vs-7 da `enviar-pedido-portal-sayerlack` reproduzido em miniatura.
    montarRepo();
    divergirDoMain();
    const f = fatiaDeDeploy('edge-e', raiz, arvoreDaRef(REF_DEPLOYADA, gitBytes(raiz)));

    expect(f.arquivos.map((a) => a.caminho)).toContain(`${SHARED}/b.ts`);
    expect(f.arquivos).toHaveLength(4);
    const porCaminho = Object.fromEntries(f.arquivos.map((a) => [a.caminho, a.sha256]));
    expect(porCaminho['supabase/functions/edge-e/a.ts']).toBe(sha256De(A_MAIN));
    expect(porCaminho['supabase/functions/edge-e/a.ts']).not.toBe(sha256De('export const a = "DISCO SUJO";\n'));
    expect(porCaminho['supabase/functions/edge-e/index.ts']).toBe(sha256De(INDEX_MAIN));
  });

  it('o MAPA entra na fatia mesmo sem estar no closure — omiti-lo serve FONTE_SHA256 velho', () => {
    montarRepo();
    const f = fatiaDeDeploy('edge-e', raiz, arvoreDaRef(REF_DEPLOYADA, gitBytes(raiz)));
    const mapa = f.arquivos.find((a) => a.caminho === MAPA);
    expect(mapa?.sha256).toBe(sha256De(MAPA_MAIN));
  });

  it('edge que existe SÓ no disco é recusada NOMEANDO a ref — não é edge para deployar', () => {
    montarRepo();
    escrever('supabase/functions/edge-fantasma/index.ts', `export default {};\n`);
    expect(() => fatiaDeDeploy('edge-fantasma', raiz, arvoreDaRef(REF_DEPLOYADA, gitBytes(raiz))))
      .toThrow(/edge inexistente em origin\/main/);
  });

  it('import da ref que não resolve NA REF é fail-closed, e a mensagem diz QUAL árvore', () => {
    montarRepo();
    escrever('supabase/functions/edge-e/index.ts', `import "./sumido.ts";\nexport default {};\n`);
    gitF('add', '-A');
    gitF('commit', '-q', '-m', 'import quebrado');
    gitF('push', '-q', 'origin', 'main');
    gitF('fetch', '-q', 'origin', 'main');
    expect(() => fatiaDeDeploy('edge-e', raiz, arvoreDaRef(REF_DEPLOYADA, gitBytes(raiz))))
      .toThrow(/import local que NÃO resolve em origin\/main/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// O hash é o MESMO que `sha256sum` imprime — a premissa da entrega inteira
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('sha256Arquivo bate com o binário que o agente vai rodar', () => {
  it('CONTROLE POSITIVO: o hash embutido = a saída de `sha256sum`/`shasum -a 256`', () => {
    // Se estes dois divergirem, TODO deploy aborta com divergência fabricada. Não dá para provar
    // isto lendo o código: só medindo contra o binário. Sem `sha256sum` nem `shasum` a asserção
    // FALHA de propósito — não conseguir medir não é o mesmo que ter medido e batido.
    montarRepo();
    escrever('amostra.bin', 'linha 1\nacentuação çãé\n');
    const nossa = sha256Arquivo(Buffer.from('linha 1\nacentuação çãé\n', 'utf8'));

    const tentativas: [string, string[]][] = [
      ['sha256sum', ['amostra.bin']],
      ['shasum', ['-a', '256', 'amostra.bin']],
    ];
    let doBinario: string | null = null;
    for (const [cmd, args] of tentativas) {
      try {
        doBinario = execFileSync(cmd, args, { cwd: raiz, encoding: 'utf8' }).trim().split(/\s+/)[0];
        break;
      } catch {
        /* tenta o próximo — macOS tem `shasum`, Linux tem `sha256sum` */
      }
    }
    expect(doBinario, 'nem `sha256sum` nem `shasum` responderam — impossível provar a premissa').not.toBeNull();
    expect(nossa).toBe(doBinario);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// A sincronização — fail-closed nas duas portas
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** `git` de mentira que grava o que foi pedido. Injetável porque a DECISÃO é o que se testa. */
function gitFake(resposta: (args: string[]) => SaidaGitBytes): {
  git: ExecutorGitBytes;
  chamadas: string[][];
} {
  const chamadas: string[][] = [];
  return {
    chamadas,
    git: (args) => {
      chamadas.push(args);
      return resposta(args);
    },
  };
}

const ok = (texto: string): SaidaGitBytes => ({ ok: true, bytes: Buffer.from(texto), erro: '' });
const falha = (erro: string): SaidaGitBytes => ({ ok: false, bytes: Buffer.alloc(0), erro });

describe('sincronizarRef', () => {
  it('busca a ref ANTES de ler — comparar contra retrato velho é o mesmo defeito um nível acima', () => {
    const { git, chamadas } = gitFake((a) => (a[0] === 'fetch' ? ok('') : ok('84a115a43\n')));
    expect(sincronizarRef(git, false)).toBe('84a115a43');
    expect(chamadas[0]).toEqual(['fetch', '--quiet', 'origin', 'main']);
  });

  it('fetch que FALHA aborta nomeando --sem-rede — não degrada para aviso', () => {
    const { git } = gitFake((a) => (a[0] === 'fetch' ? falha('Could not resolve host') : ok('abc1234')));
    expect(() => sincronizarRef(git, false)).toThrow(/git fetch origin main` falhou/);
    expect(() => sincronizarRef(git, false)).toThrow(/Nenhum prompt foi emitido/);
  });

  it('--sem-rede pula SÓ o fetch; a leitura continua saindo da ref', () => {
    const { git, chamadas } = gitFake(() => ok('84a115a43\n'));
    expect(sincronizarRef(git, true)).toBe('84a115a43');
    expect(chamadas.some((c) => c[0] === 'fetch')).toBe(false);
  });

  it('origin/main que não existe aborta — ausência de dado não é aprovação', () => {
    const { git } = gitFake((a) => (a[0] === 'fetch' ? ok('') : falha('')));
    expect(() => sincronizarRef(git, false)).toThrow(/origin\/main não existe neste repo/);
  });

  it('rev-parse que sai 0 com stdout VAZIO também aborta (o exit não é o veredito)', () => {
    const { git } = gitFake(() => ok('   \n'));
    expect(() => sincronizarRef(git, true)).toThrow(/não existe neste repo/);
  });
});

describe('gitBytes — spawn que não respondeu NÃO é sucesso', () => {
  it('binário inexistente devolve ok:false, não ok:true com bytes vazios', () => {
    montarRepo();
    const r = gitBytes(raiz)(['nao-e-um-subcomando-de-git']);
    expect(r.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// `main()` — os exits, e o que sai (ou não) no stdout
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('main — nunca imprime colagem num caminho de erro', () => {
  let saida: string;
  beforeEach(() => {
    saida = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      saida += String(c);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('caminho feliz: exit 0, prompt com os arquivos, os hashes da MAIN e a procedência', () => {
    montarRepo();
    divergirDoMain(); // o disco sujo NÃO pode aparecer na saída
    const sha = gitF('rev-parse', REF_DEPLOYADA);
    expect(main(['edge-e'], raiz)).toBe(0);
    expect(saida).toContain(`- \`${SHARED}/b.ts\` — sha256 \`${sha256De(B_MAIN)}\``);
    expect(saida).toContain(`- \`supabase/functions/edge-e/a.ts\` — sha256 \`${sha256De(A_MAIN)}\``);
    expect(saida).not.toContain(sha256De('export const a = "DISCO SUJO";\n'));
    expect(saida).toContain(`\`origin/main\` at commit \`${sha}\``);
    expect(saida).toContain('run `sha256sum <path>`');
    expect(saida).toContain('do NOT deploy');
  });

  it('fetch quebrado: exit 2 e stdout VAZIO — colagem sem conferência é pior que colagem nenhuma', () => {
    montarRepo();
    const { git } = gitFake((a) => (a[0] === 'fetch' ? falha('sem rede') : ok('84a115a43')));
    expect(main(['edge-e'], raiz, git)).toBe(2);
    expect(saida).toBe('');
  });

  it('edge que não existe na ref: exit 2 e stdout vazio', () => {
    montarRepo();
    expect(main(['edge-fantasma'], raiz)).toBe(2);
    expect(saida).toBe('');
  });

  it('--sem-rede emite o prompt e não é confundido com nome de edge', () => {
    montarRepo();
    expect(main(['edge-e', '--sem-rede'], raiz)).toBe(0);
    expect(saida).toContain('supabase/functions/edge-e/index.ts');
  });

  it('sem argumento nenhum: exit 2, uso no stderr, nada no stdout', () => {
    montarRepo();
    expect(main([], raiz)).toBe(2);
    expect(saida).toBe('');
  });
});
