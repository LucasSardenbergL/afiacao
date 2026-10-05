import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main as mainPacote } from '../pendencias-pacote';
import { main as mainPrompt } from '../pendencias-prompt';
import { ARQ_MAPA, type ArvoreDeFonte, calcularTodos, parsearMapa, RAIZ_EDGES, renderizarMapa } from '../sonda-fingerprint';
import { conferirMapaNaRef } from './mapa-coerente-na-ref';
import { contarPulsos, descreverPulsos, rodarOk } from '@/test/loop-livre';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// O furo (#2611, docs/historico/sonda-bump-retorno-ao-canonico.md §2)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// A sonda serve `FONTE_SHA256[edge]` ESTÁTICO. O bot do Lovable edita o corpo na `main` sem
// regravar o mapa; um pacote montado dali deploya o corpo do bot e prod passa a responder o par
// CANÔNICO — o ledger dá CONFERE. Estes testes montam esse repo DE VERDADE (git init, clone do bot,
// push, fetch) e exigem que os dois emissores de colagem RECUSEM (exit 5).
//
// O disco da worktree local fica no commit CANÔNICO de propósito: é o cenário real (o founder não
// puxou o commit do bot) e é o que torna VERMELHO um emissor que leia o disco em vez da ref — com
// disco = ref, "ler do disco" passaria despercebido.
//
// Cada recusa tem o CONTROLE verde no mesmo `describe` (sem ele, um gate que recusa SEMPRE passaria),
// e as marcas `[MAPA_*]` são as que o `scripts/falsificar-mapa-coerente.sh` exige no vermelho.

const EDGE = 'sync-x';
const SEM_SONDA = 'sem-sonda';
const DEPENDENTE = 'edge-b';
const BOT = { nome: 'gpt-engineer-app[bot]', email: '159125892+gpt-engineer-app[bot]@users.noreply.github.com' };
const HUMANO = { nome: 'humano', email: 'h@h' };

const INDEX = `import { total } from "../_shared/calc.ts";\nimport { VERSAO } from "./versao.ts";\nexport default (codigoPedido: string) => [VERSAO, total(codigoPedido)];\n`;
const INDEX_DO_BOT = INDEX.replace('total(codigoPedido)', 'total(String(Number(codigoPedido)))');
const CALC = `export const total = (s: string) => s.length;\n`;
const CALC_DO_BOT = `export const total = (s: string) => Number(s);\n`;
const MIGRATION = 'CREATE OR REPLACE FUNCTION public.rpc_qualquer() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n';

let base: string;
let remoto: string;
let local: string;
let lovable: string;
let stderr: string;
let stdout: string;

// O `git` dos repos de mentira é ASSÍNCRONO (`rodarOk`): síncronos, os forks deles (11–19 por `it`)
// colavam nos do código sob teste num bloco só que segurava o event loop do worker — 4,0s sob carga
// em 2026-10-05, o maior do arquivo —, e acima de 60s o RPC do vitest estoura: `test` rc=1 sem teste
// falhando (src/test/loop-livre.ts).
async function git(dir: string, autor: { nome: string; email: string }, ...args: string[]): Promise<string> {
  return (
    await rodarOk('git', [
      '-C', dir, '-c', `user.email=${autor.email}`, '-c', `user.name=${autor.nome}`, '-c', 'commit.gpgsign=false', ...args,
    ])
  ).trim();
}

function escrever(dir: string, rel: string, conteudo: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, conteudo, 'utf8');
}

/** O `sonda:fingerprint -- --write` de verdade, sobre o disco de `dir`. */
function regravarMapa(dir: string): void {
  escrever(dir, ARQ_MAPA, renderizarMapa(calcularTodos(dir)));
}

/** Commit em `lovable` + push; a worktree `local` só VÊ via fetch (o disco dela não muda). */
async function commitRemoto(autor: typeof BOT, mudar: (dir: string) => void, msg = 'Changes'): Promise<void> {
  mudar(lovable);
  await git(lovable, autor, 'add', '-A');
  await git(lovable, autor, 'commit', '-q', '-m', msg);
  await git(lovable, autor, 'push', '-q', 'origin', 'main');
  await git(local, HUMANO, 'fetch', '-q', 'origin');
}

async function montarRepo(opcoes: { dependente?: boolean } = {}): Promise<void> {
  await rodarOk('git', ['init', '--bare', '-q', '-b', 'main', remoto]);
  await git(local, HUMANO, 'init', '-q', '-b', 'main');
  await git(local, HUMANO, 'remote', 'add', 'origin', remoto);
  escrever(local, `${RAIZ_EDGES}/${EDGE}/index.ts`, INDEX);
  escrever(local, `${RAIZ_EDGES}/${EDGE}/versao.ts`, 'export const VERSAO = "v1.9";\n');
  escrever(local, `${RAIZ_EDGES}/_shared/calc.ts`, CALC);
  escrever(local, `${RAIZ_EDGES}/${SEM_SONDA}/index.ts`, 'export default {};\n');
  escrever(local, 'supabase/migrations/20260101000000_base.sql', MIGRATION);
  if (opcoes.dependente) {
    escrever(local, `${RAIZ_EDGES}/${DEPENDENTE}/index.ts`, 'export default {};\n');
    escrever(
      local,
      `${RAIZ_EDGES}/${DEPENDENTE}/deploy-ordem.json`,
      JSON.stringify({ formato: 'deploy-ordem/1', depoisDe: [{ edge: EDGE, motivo: 'grava o que a sync-x lê primeiro', pr: 2611 }] }),
    );
  }
  regravarMapa(local);
  await git(local, HUMANO, 'add', '-A');
  await git(local, HUMANO, 'commit', '-q', '-m', 'base');
  await git(local, HUMANO, 'push', '-q', '-u', 'origin', 'main');
  await rodarOk('git', ['clone', '-q', remoto, lovable]);
}

const medirProibido = (sql: string): string => {
  throw new Error(`a sonda de banco não devia rodar (leva sem RPC): ${sql.slice(0, 40)}`);
};
const semStdin = (): string => {
  throw new Error('o stdin não devia ser lido: a leva veio por nome');
};
const AGORA = () => new Date('2026-09-27T21:00:00.000Z');

function pacote(
  edges: string[],
  opcoes: { entrada?: () => string; flags?: string[] } = {},
): { codigo: number; saida: string } {
  const saida = join(base, 'pacote.md');
  const codigo = mainPacote(
    [...edges, '--saida', saida, '--sem-rede', ...(opcoes.flags ?? [])],
    local,
    undefined,
    medirProibido,
    opcoes.entrada ?? semStdin,
    AGORA,
  );
  return { codigo, saida };
}

/**
 * O `--json` do `pendencias:deploy` com a predecessora PROVADA: servindo, há 30 min, exatamente o par
 * que o mapa da ref declara — que é o que prod responde tanto com o corpo canônico quanto com o do
 * bot. Sem a conferência do mapa, isso libera a dependente.
 */
function ledgerComPredecessoraProvada(): () => string {
  const fonte = parsearMapa(readFileSync(join(local, ARQ_MAPA), 'utf8'))[EDGE];
  const v = (edge: string, over: Record<string, unknown>) => ({
    edge, estado: 'CONFERE', esperado: fonte, observado: fonte, versaoEsperada: 'v1.9', versao: 'v1.9',
    via: 'sonda', criado: '2026-09-27 20:30:00+00', idadeHoras: 0.5, diasPendente: null, escalada: false, ...over,
  });
  return () => JSON.stringify({
    formato: 'pendencias-deploy/1',
    ref: 'origin/main',
    geradoEm: '2026-09-27T20:59:00.000Z',
    vereditos: [
      v(EDGE, {}),
      v(DEPENDENTE, { estado: 'DIVERGE_P1', esperado: 'e'.repeat(64), observado: 'd'.repeat(64), versao: 'v0' }),
    ],
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mapa-coerente-'));
  remoto = join(base, 'remoto.git');
  local = join(base, 'local');
  lovable = join(base, 'lovable');
  mkdirSync(local, { recursive: true });
  stderr = '';
  stdout = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    stderr += String(c);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    stdout += String(c);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

// A guarda do `git` — o que o repo de mentira usa: um git que DORME 200ms (alias `!sleep`),
// duração determinística, para o pulso ter o que contar em qualquer máquina (6 forks de git no Linux
// do CI somam menos que um pulso). Síncrono, ele bate zero.
it('o git dos repos de mentira NÃO prende o event loop do worker — o pulso bate com o filho vivo', async () => {
  const p = await contarPulsos(() => git(local, HUMANO, '-c', 'alias.dorme=!sleep 0.2', 'dorme'));
  expect(p.batidas, descreverPulsos(p)).toBeGreaterThanOrEqual(2);
});

describe('pendencias:pacote — mapa da REF tem de descrever a fonte da REF', () => {
  it('[MAPA_CONTROLE_COERENTE_LIBERA] controle: main coerente sai com pacote (exit 0)', async () => {
    await montarRepo();
    const { codigo, saida } = pacote([EDGE]);
    expect(codigo).toBe(0);
    expect(existsSync(saida)).toBe(true);
    expect(stderr).not.toContain('RECUSADO');
  });

  it('[MAPA_BOT_EDITA_INDEX_RECUSA] commit do bot no index.ts sem regravar o mapa: exit 5, pacote nenhum', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/${EDGE}/index.ts`, INDEX_DO_BOT));

    const { codigo, saida } = pacote([EDGE]);

    expect(codigo).toBe(5);
    expect(existsSync(saida)).toBe(false);
    expect(stderr).toContain('RECUSADO');
    expect(stderr).toContain(`${EDGE}: mapa `);
    // O porquê e o remédio, não só o "não".
    expect(stderr).toContain('FONTE_SHA256[edge]');
    expect(stderr).toContain('revert por PR');
    expect(stderr).toContain('sonda:fingerprint -- --write');
  });

  it('[MAPA_BOT_EDITA_SHARED_RECUSA] o bot mexe só em _shared/ do fecho: exit 5', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/_shared/calc.ts`, CALC_DO_BOT));
    expect(pacote([EDGE]).codigo).toBe(5);
  });

  it('[MAPA_REMEDIO_WRITE_LIBERA] controle: depois do --write commitado por PR, o mesmo corpo sai (exit 0)', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/${EDGE}/index.ts`, INDEX_DO_BOT));
    await commitRemoto(HUMANO, (d) => regravarMapa(d), 'chore(sonda): regrava o mapa');
    expect(pacote([EDGE]).codigo).toBe(0);
  });

  it('[MAPA_EDGE_FORA_DO_MAPA_RECUSA] edge instrumentada que o mapa não lista: exit 5', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/${SEM_SONDA}/versao.ts`, 'export const VERSAO = "v1";\n'));
    expect(pacote([SEM_SONDA]).codigo).toBe(5);
    expect(stderr).toContain(`${SEM_SONDA}: mapa SEM a edge`);
  });

  it('[MAPA_SEM_SONDA_FORA_DO_REGIME] controle: edge sem versao.ts não serve fonte — editar não recusa', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/${SEM_SONDA}/index.ts`, 'export default { bot: 1 };\n'));
    expect(pacote([SEM_SONDA]).codigo).toBe(0);
  });

  it('[MAPA_PREDECESSORA_INCOERENTE_RECUSA] predecessora com mapa incoerente não prova a ordem, nem com o ledger dizendo CONFERE (exit 5)', async () => {
    await montarRepo({ dependente: true });
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/${EDGE}/index.ts`, INDEX_DO_BOT));
    // O ledger mostra a sync-x servindo o par do mapa — o MESMO par com o corpo do bot no ar. Sem a
    // conferência, a edge-b sairia liberada (exit 0) sobre uma prova que não distingue os dois mundos.
    expect(pacote(['-'], { entrada: ledgerComPredecessoraProvada() }).codigo).toBe(5);
    expect(stderr).toContain(`${EDGE}: mapa `);
  });

  it('[MAPA_PREDECESSORA_CONTROLE_LIBERA] controle: predecessora coerente e provada libera a dependente (exit 0)', async () => {
    await montarRepo({ dependente: true });
    expect(pacote(['-'], { entrada: ledgerComPredecessoraProvada() }).codigo).toBe(0);
    expect(stderr).not.toContain('RECUSADO');
  });

  it('[MAPA_FORA_DA_FORMA_RECUSA] o bot acrescenta código ao mapa, com as entradas intactas: exit 5', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => appendFileSync(join(d, ARQ_MAPA), '(globalThis as any).Number = () => 0;\n'));
    expect(pacote([EDGE]).codigo).toBe(5);
    expect(stderr).toContain('texto a mais no mapa');
  });

  it('[MAPA_SEM_MARCADOR_NO_MAPA_RECUSA] o bot tira o versao.ts e leva a VERSAO para o index, mapa intacto: exit 5', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => {
      unlinkSync(join(d, RAIZ_EDGES, EDGE, 'versao.ts'));
      escrever(d, `${RAIZ_EDGES}/${EDGE}/index.ts`, INDEX.replace('import { VERSAO } from "./versao.ts";\n', 'const VERSAO = "v1.9";\n'));
    });
    expect(pacote([EDGE]).codigo).toBe(5);
    expect(stderr).toContain(`${EDGE}: está no mapa`);
  });

  it('[MAPA_SQL_NUVEM_RECUSA] pela nuvem, a 1ª rodada também recusa — stdout VAZIO e exit 5, não o 0 de "sem RPC"', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/${EDGE}/index.ts`, INDEX_DO_BOT));
    expect(pacote([EDGE], { flags: ['--sql-nuvem'] }).codigo).toBe(5);
    expect(stdout).toBe('');
  });

  it('controle: pela nuvem com main coerente e leva sem RPC, o 0 de sempre', async () => {
    await montarRepo();
    expect(pacote([EDGE], { flags: ['--sql-nuvem'] }).codigo).toBe(0);
    expect(stdout).toBe('');
  });
});

describe('pendencias:prompt — o irmão que também emite colagem', () => {
  it('[MAPA_PROMPT_BOT_RECUSA] commit do bot: exit 5 e stdout VAZIO', async () => {
    await montarRepo();
    await commitRemoto(BOT, (d) => escrever(d, `${RAIZ_EDGES}/${EDGE}/index.ts`, INDEX_DO_BOT));
    expect(mainPrompt([EDGE, '--sem-rede'], local)).toBe(5);
    expect(stdout).toBe('');
    expect(stderr).toContain('RECUSADO');
  });

  it('[MAPA_PROMPT_CONTROLE_LIBERA] controle: main coerente emite a colagem (exit 0)', async () => {
    await montarRepo();
    expect(mainPrompt([EDGE, '--sem-rede'], local)).toBe(0);
    expect(stdout).toContain(EDGE);
  });
});

describe('conferirMapaNaRef — a mecânica que não responde lança', () => {
  const vazia: ArvoreDeFonte = { rotulo: 'fixture', ler: () => null };

  it('[MAPA_INVENTARIO_CEGO_LANCA] inventário que não lista o index.ts da própria edge LANÇA', () => {
    expect(() =>
      conferirMapaNaRef({ edges: [EDGE], arvore: vazia, inventario: new Set(), raiz: '/fixture' }),
    ).toThrow(/não lista o index\.ts de sync-x/);
  });

  it('controle: edge sem versao.ts e sem mapa na árvore fica fora do regime, sem lançar', () => {
    const r = conferirMapaNaRef({
      edges: [EDGE],
      arvore: vazia,
      inventario: new Set([`${RAIZ_EDGES}/${EDGE}/index.ts`]),
      raiz: '/fixture',
    });
    expect(r).toEqual({ coerentes: [], foraDoRegime: [EDGE], incoerentes: [], mapaForaDaForma: false });
  });

  // No CLI este ramo é inalcançável — a camada 1 (`fatiaDeDeploy`) já exige o mapa (Codex, 2026-09-27)
  // —, então ele se prova aqui, na lib, onde um emissor futuro sem aquela camada dependeria dele.
  it('[MAPA_SEM_ARQUIVO_MECANICA] edge com versao.ts e mapa ausente na árvore LANÇA, não vira coerente', () => {
    expect(() =>
      conferirMapaNaRef({
        edges: [EDGE],
        arvore: vazia,
        inventario: new Set([`${RAIZ_EDGES}/${EDGE}/index.ts`, `${RAIZ_EDGES}/${EDGE}/versao.ts`]),
        raiz: '/fixture',
      }),
    ).toThrow(/sonda-fingerprints\.ts ilegível em fixture/);
  });
});
