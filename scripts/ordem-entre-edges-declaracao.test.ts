import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conferirInventario,
  corpoDoEvento,
  executar,
  inventariar,
  lerArgs,
  lerDiffNameStatus,
  MARCA_MEDICAO_FALHOU,
  obterCorpo,
  type Rodar,
} from './ordem-entre-edges-declaracao';

// As marcas [CLI_*] dos títulos são o que `scripts/falsificar-ordem-entre-edges-declaracao.sh` exige
// no vermelho de cada sabotagem: ASCII, caixa fixa, e só aparecem quando o teste FALHA.

const semRede: Rodar = () => {
  throw new Error('rede não era esperada neste teste');
};

const tmp = mkdtempSync(join(tmpdir(), 'ordem-decl-tmp-'));
let arquivos = 0;
const arquivo = (conteudo: string): string => {
  const f = join(tmp, `arquivo-${++arquivos}`);
  writeFileSync(f, conteudo);
  return f;
};
const evento = (corpo: string | null): string => arquivo(JSON.stringify({ pull_request: { number: 7, body: corpo } }));

describe('lerArgs — de onde vem o corpo e contra o quê medir', () => {
  it('[CLI_ARGS_FONTES] aceita evento, arquivo de corpo e número de PR, com base e head opcionais', () => {
    expect(lerArgs(['--evento', 'e.json'])).toEqual({ fonte: { tipo: 'evento', caminho: 'e.json' } });
    expect(lerArgs(['--corpo-arquivo', 'c.md', '--base', 'b1', '--head', 'h1'])).toEqual({
      fonte: { tipo: 'arquivo', caminho: 'c.md' },
      base: 'b1',
      head: 'h1',
    });
    expect(lerArgs(['--pr', '2510'])).toEqual({ fonte: { tipo: 'pr', numero: 2510 } });
  });

  // `bun run ordem:declaracao -- --evento x` pode entregar o `--` ao script; ele não é argumento.
  it('[CLI_ARGS_SEPARADOR] ignora o -- do bun run', () => {
    expect(lerArgs(['--', '--evento', 'e.json'])).toEqual({ fonte: { tipo: 'evento', caminho: 'e.json' } });
  });

  it('[CLI_ARGS_UMA_FONTE] exige exatamente uma fonte de corpo', () => {
    expect(lerArgs([])).toHaveProperty('erro');
    expect(lerArgs(['--evento', 'e.json', '--pr', '1'])).toHaveProperty('erro');
  });

  it('[CLI_ARGS_INVALIDOS] recusa flag desconhecida, flag sem valor e PR que não é número', () => {
    expect(lerArgs(['--evento', 'e.json', '--xpto'])).toHaveProperty('erro');
    expect(lerArgs(['--evento'])).toHaveProperty('erro');
    expect(lerArgs(['--pr', '12a'])).toHaveProperty('erro');
  });
});

describe('corpoDoEvento — o payload do pull_request', () => {
  it('[CLI_EVENTO_CORPO] lê corpo e número; corpo nulo vira vazio', () => {
    expect(corpoDoEvento({ pull_request: { number: 7, body: 'x' } })).toEqual({ corpo: 'x', numero: 7 });
    expect(corpoDoEvento({ pull_request: { number: 7, body: null } })).toEqual({ corpo: '', numero: 7 });
  });

  // Corpo vazio por ERRO não é corpo vazio por mérito: fora da população, o vazio aprovaria por cegueira.
  it('[CLI_EVENTO_MALFORMADO] evento sem pull_request, sem número ou sem body é erro', () => {
    expect(corpoDoEvento({})).toHaveProperty('erro');
    expect(corpoDoEvento({ pull_request: { body: 'x' } })).toHaveProperty('erro');
    expect(corpoDoEvento({ pull_request: { number: 7 } })).toHaveProperty('erro');
  });
});

describe('obterCorpo — o re-run relê o corpo ATUAL', () => {
  const gravador = (): { rodar: Rodar; chamadas: string[][] } => {
    const chamadas: string[][] = [];
    return {
      chamadas,
      rodar: (args) => {
        chamadas.push(args);
        return { ok: true, saida: 'Ordem entre edges: nenhuma' };
      },
    };
  };

  it('[CLI_CORPO_PRIMEIRA_TENTATIVA] a 1ª tentativa usa o corpo do evento, sem rede', () => {
    const g = gravador();
    expect(obterCorpo({ tipo: 'evento', caminho: evento('do evento') }, { GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'o/r' }, g.rodar)).toEqual({
      corpo: 'do evento',
    });
    expect(g.chamadas).toEqual([]);
  });

  // O "Re-run" do Actions reusa o payload do evento original: sem reler, o re-run feito depois de
  // corrigir o corpo julgaria o corpo velho.
  it('[CLI_CORPO_RERUN_RELE] o re-run relê o corpo pela API, no PR do evento', () => {
    const g = gravador();
    expect(obterCorpo({ tipo: 'evento', caminho: evento('velho') }, { GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'o/r' }, g.rodar)).toEqual({
      corpo: 'Ordem entre edges: nenhuma',
    });
    expect(g.chamadas).toEqual([['api', 'repos/o/r/pulls/7', '--jq', '.body // ""']]);
  });

  it('[CLI_CORPO_RELEITURA_FALHA] releitura que falha é erro, nunca o corpo velho', () => {
    const falha: Rodar = () => ({ ok: false, saida: '' });
    expect(obterCorpo({ tipo: 'evento', caminho: evento('velho') }, { GITHUB_RUN_ATTEMPT: '3', GITHUB_REPOSITORY: 'o/r' }, falha)).toHaveProperty(
      'erro',
    );
  });

  it('[CLI_CORPO_PR_LOCAL] --pr lê o corpo pela API do repo corrente', () => {
    const g = gravador();
    expect(obterCorpo({ tipo: 'pr', numero: 12 }, {}, g.rodar)).toEqual({ corpo: 'Ordem entre edges: nenhuma' });
    expect(g.chamadas).toEqual([['api', 'repos/{owner}/{repo}/pulls/12', '--jq', '.body // ""']]);
  });

  it('[CLI_CORPO_ARQUIVO_AUSENTE] arquivo de corpo que não existe é erro', () => {
    expect(obterCorpo({ tipo: 'arquivo', caminho: join(tmp, 'nao-existe.md') }, {}, semRede)).toHaveProperty('erro');
  });
});

describe('lerDiffNameStatus — a saída -z do git diff', () => {
  // `-z` porque sem ele o git põe entre aspas e escapa o caminho com acento (`core.quotepath`).
  it('[CLI_DIFF_Z] lê status e caminho separados por NUL, inclusive caminho com espaço e acento', () => {
    expect(
      lerDiffNameStatus('M\0supabase/functions/a/index.ts\0D\0supabase/functions/b/deploy-ordem.json\0A\0supabase/functions/a/lib/ação x.ts\0'),
    ).toEqual([
      { status: 'M', caminho: 'supabase/functions/a/index.ts' },
      { status: 'D', caminho: 'supabase/functions/b/deploy-ordem.json' },
      { status: 'A', caminho: 'supabase/functions/a/lib/ação x.ts' },
    ]);
    expect(lerDiffNameStatus('')).toEqual([]);
  });

  // Com `--no-renames` não existe R/C; se aparecer, o pareamento status/caminho desalinhou.
  it('[CLI_DIFF_INESPERADO_LANCA] status desconhecido ou saída truncada lançam', () => {
    expect(() => lerDiffNameStatus('R100\0a\0b\0')).toThrow('status inesperado');
    expect(() => lerDiffNameStatus('M\0')).toThrow('truncada');
  });
});

describe('inventariar — edge é pasta com index.ts', () => {
  it('[CLI_INVENTARIO] edge é pasta com index.ts no 1º nível; manifesto é o deploy-ordem.json de qualquer pasta', () => {
    expect(
      inventariar([
        'supabase/functions/a/index.ts',
        'supabase/functions/a/lib/util.ts',
        'supabase/functions/b/index.ts',
        'supabase/functions/b/deploy-ordem.json',
        'supabase/functions/c/sub/index.ts',
        'supabase/functions/c/deploy-ordem.json',
        'supabase/functions/_shared/x.ts',
      ]),
    ).toEqual({ edges: new Set(['a', 'b']), manifestos: ['b', 'c'] });
  });
});

describe('conferirInventario — lista vazia por ERRO não é lista vazia por mérito', () => {
  const inventario = ['supabase/functions/a/index.ts', 'supabase/functions/a/lib/x.ts'];

  it('[CLI_CONTROLE_OK] inventário com edge e com os caminhos esperados passa', () => {
    expect(conferirInventario(inventario, ['supabase/functions/a/lib/x.ts'], 'HEAD')).toBeNull();
  });

  it('[CLI_CONTROLE_SEM_EDGE] inventário sem nenhuma edge reprova', () => {
    expect(conferirInventario(['supabase/functions/_shared/x.ts'], [], 'HEAD')).toContain('HEAD');
  });

  it('[CLI_CONTROLE_CAMINHO_FALTANDO] caminho do diff fora do inventário reprova', () => {
    expect(conferirInventario(inventario, ['supabase/functions/b/index.ts'], 'base')).toContain('supabase/functions/b/index.ts');
  });
});

describe('executar — a fiação do git, num repo que o TESTE constrói', () => {
  // Os testes do núcleo recebem os mapas prontos; o `git diff`, o `ls-tree` e o `git show` só se
  // provam aqui. Trocar a lista do diff por `[]` deixaria verde todo teste que só olha o núcleo.
  const repo = mkdtempSync(join(tmpdir(), 'ordem-decl-repo-'));
  const revs: Record<string, string> = {};
  const envAntes = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${r.stderr}`);
    return r.stdout.trim();
  };
  const escrever = (conteudos: Record<string, string>): void => {
    for (const [rel, conteudo] of Object.entries(conteudos)) {
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      writeFileSync(join(repo, rel), conteudo);
    }
  };
  const commitar = (msg: string): string => {
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const manifesto = (motivo: string): string =>
    JSON.stringify({ formato: 'deploy-ordem/1', depoisDe: [{ edge: 'a', motivo, pr: 1 }] });
  const rodar = (argv: string[], ambiente: Record<string, string> = {}): ReturnType<typeof executar> => {
    const cwdAntes = process.cwd();
    process.chdir(repo);
    try {
      return executar(argv, ambiente, semRede);
    } finally {
      process.chdir(cwdAntes);
    }
  };
  const medir = (corpo: string, base: string, head: string): ReturnType<typeof executar> =>
    rodar(['--corpo-arquivo', arquivo(corpo), '--base', revs[base], '--head', revs[head]]);

  beforeAll(() => {
    // config global vazia: o repo do teste não herda a config de quem roda
    process.env.GIT_CONFIG_GLOBAL = arquivo('');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    git('init', '-q');
    escrever({
      'supabase/functions/a/index.ts': 'export const a = 1;\n',
      'supabase/functions/b/index.ts': 'export const b = 1;\n',
      'supabase/functions/_shared/util.ts': 'export const u = 1;\n',
    });
    revs.base = commitar('base');
    escrever({ 'supabase/functions/a/index.ts': 'export const a = 2;\n', 'supabase/functions/b/index.ts': 'export const b = 2;\n' });
    revs.duasEdges = commitar('duas edges');
    escrever({ 'supabase/functions/b/deploy-ordem.json': manifesto('na ordem inversa a edge velha reescreve o dado novo') });
    revs.comManifesto = commitar('manifesto');
    escrever({ 'supabase/functions/b/deploy-ordem.json': manifesto('outro motivo, também com mais de vinte caracteres') });
    revs.motivoTrocado = commitar('motivo trocado');
    escrever({ 'supabase/functions/b/deploy-ordem.json': '{' });
    revs.ilegivel = commitar('manifesto ilegível');
    git('rm', '-rq', 'supabase/functions');
    escrever({ 'LEIAME.md': 'sem edges\n' });
    revs.semEdges = commitar('sem edges');
  });

  afterAll(() => {
    if (envAntes.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = envAntes.global;
    if (envAntes.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = envAntes.nosystem;
    rmSync(repo, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('[CLI_REPO_AUSENTE] duas edges sem declaração reprovam com exit 1', () => {
    const r = medir('## Deploy\n\nnesta ordem: a → b', 'base', 'duasEdges');
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('ORDEM_DECLARACAO_AUSENTE');
  });

  it('[CLI_REPO_NENHUMA] duas edges com nenhuma aprovam com exit 0', () => {
    const r = medir('Ordem entre edges: nenhuma', 'base', 'duasEdges');
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('ORDEM_DECLARADA_NENHUMA');
  });

  it('[CLI_REPO_MANIFESTO_DO_HEAD] par declarado com o manifesto lido do HEAD aprova', () => {
    const r = medir('Ordem entre edges: a → b', 'base', 'comManifesto');
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('ORDEM_DECLARADA_PARES');
  });

  it('[CLI_REPO_PAR_NOVO] manifesto que ganha par, com nenhuma, reprova', () => {
    const r = medir('Ordem entre edges: nenhuma', 'base', 'comManifesto');
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('ORDEM_PAR_NAO_DECLARADO');
  });

  it('[CLI_REPO_PAR_DA_BASE] manifesto tocado sem par novo não exige declarar o par que a base já tinha', () => {
    const r = medir('Ordem entre edges: nenhuma', 'comManifesto', 'motivoTrocado');
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('ORDEM_DECLARADA_NENHUMA');
  });

  it('[CLI_REPO_MANIFESTO_ILEGIVEL] manifesto ilegível no HEAD é achado do PR (exit 1), não falha mecânica', () => {
    const r = medir('Ordem entre edges: nenhuma', 'motivoTrocado', 'ilegivel');
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('ORDEM_MANIFESTO_ILEGIVEL');
  });

  it('[CLI_REPO_REV_INEXISTENTE] head que não resolve é falha mecânica (exit 2)', () => {
    const r = rodar(['--corpo-arquivo', arquivo('Ordem entre edges: nenhuma'), '--base', revs.base, '--head', 'nao-existe-000']);
    expect(r.codigo).toBe(2);
    expect(r.saida).toContain(MARCA_MEDICAO_FALHOU);
  });

  // Sem o controle positivo, HEAD sem edge nenhuma daria população vazia — e aprovaria por cegueira.
  it('[CLI_REPO_HEAD_SEM_EDGE] HEAD sem nenhuma edge é falha mecânica, não aprovação', () => {
    const r = medir('', 'base', 'semEdges');
    expect(r.codigo).toBe(2);
    expect(r.saida).toContain(MARCA_MEDICAO_FALHOU);
  });

  it('[CLI_REPO_EVENTO] o corpo do evento chega ao julgamento', () => {
    const r = rodar(['--evento', evento('Ordem entre edges: a → b'), '--base', revs.base, '--head', revs.comManifesto], {
      GITHUB_RUN_ATTEMPT: '1',
    });
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('ORDEM_DECLARADA_PARES');
  });
});
