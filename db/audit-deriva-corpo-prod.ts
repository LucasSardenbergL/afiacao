#!/usr/bin/env bun
/**
 * audit-deriva-corpo-prod.ts — AUDITORIA de prod (READ-ONLY via psql-ro) do CORPO de toda função
 * `public` que alguma migration de `supabase/migrations/` define.
 *
 * ## Por que existe (`docs/historico/deriva-corpo-sem-sensor.md`)
 *
 * Em 2026-09-07 a `20260906170000` foi colada no SQL Editor DEPOIS da `20260907095841`, e
 * `public.cancelar_pedido_sugerido` rodou 18 dias o corpo antigo — "a última a recriar vence"
 * (`docs/agent/database.md` §2). Os audits de migration olham EXISTÊNCIA; o `authz:funcoes:prod`
 * cobre o manifesto de authz. Quem viu foi o eixo de corpo do gate do pacote, e só porque uma edge
 * do conjunto acoplado foi deployada: função fora de qualquer leva de deploy não tinha sensor.
 *
 * ## O que mede (a lógica pura, testada, mora em `scripts/lib/deriva-corpo.ts`)
 *
 * Lê TODAS as migrations do commit `origin/main` (depois de um `git fetch` — sem ele "bate" seria
 * contra expectativa velha) e modela o estado TERMINAL de cada identidade (`nome(tipos)`):
 * CREATE/DROP/SET SCHEMA/RENAME na ordem de apply, patches por âncora posteriores. Mede prod numa
 * transação REPEATABLE READ só — a sonda do gate do pacote (`montarSondaPrecondicao`, com os
 * controles e autotestes dela) e o detalhe por overload — e julga cada identidade: EM_DIA,
 * COSMETICO (mesmos tokens), ACEITA (baseline), ou divergência nomeada.
 *
 * O contrato é a baseline de deriva ACEITA (`db/deriva-corpo-baseline.json`): o que alguém olhou e
 * aceitou (edição manual, patch conciliado, versão não mensurável).
 *
 * Exit `0` bate · `1` divergiu · `2` não consegui medir (medição incompleta NUNCA sai 0).
 * Roda sob demanda, no ritual `/fecho` e no carimbo de audits de prod (`AUDITS`); não no CI, que
 * não tem `psql-ro`. Dente: `db/test-audit-deriva-corpo-prod.sh` (PG17, os dois locales).
 *
 * `--sem-rede` mede sem `git fetch` — e o denominador DIZ isso. `AUTHZ_DERIVA_CORPO_TEST_JSON`
 * (arquivo `{ migrations, baseline }`) troca o repo por uma fixture: é o que o harness usa, e é
 * por casar `AUTHZ_*_TEST_JSON` que o carimbo se recusa a gravar com ele setado.
 *
 * ## Pela NUVEM (2026-10-01): `--sql-nuvem` / `--dados-nuvem=<arquivo>`
 *
 * A sessão da nuvem não tem `psql-ro` (a credencial não sai do Mac — `docs/agent/database.md` §1).
 * A MESMA medição vai pelo transporte de `scripts/lib/transporte-nuvem.ts`, em duas rodadas que leem
 * o repo do mesmo jeito — a sonda depende dele, os nomes vêm das migrations da `origin/main`:
 *   1. `--sql-nuvem` faz o fetch, modela o repo e imprime UM SQL: as duas consultas da sonda
 *      (`consultasDeriva`) num statement só, que tem UM retrato (a garantia do REPEATABLE READ);
 *   2. o modelo o roda VERBATIM pelo `query_database` do conector Lovable e grava a resposta;
 *   3. `--dados-nuvem=<arquivo>` refaz o fetch e o SQL, valida a resposta (md5, `sql_md5`, trava,
 *      frescor) e entrega ao MESMO juízo o texto que o psql imprimiria (`saidaComoPsql`).
 * Se a main mudar o conjunto de funções entre as rodadas, o SQL refeito não é o executado e o
 * transporte recusa (`TRANSPORTE_SQL_DIVERGENTE`, exit 2): rode as duas de novo.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { mensagemDeErro } from '@/lib/erro-mensagem';

import { historicoDeCorpos, type MigrationLida } from '../scripts/lib/corpo-esperado';
import {
  consultasDeriva,
  type EntradaBaseline,
  julgarDeriva,
  lerBaseline,
  modelarRepo,
  montarSondaDeriva,
  parsearSondaDeriva,
  relatarDeriva,
  saidaDerivaComoPsql,
  textosDaLeitura,
} from '../scripts/lib/deriva-corpo';
import { migrationsDaRef } from '../scripts/lib/migrations-da-ref';
import { alvosDeCorpo, julgarPrecondicao } from '../scripts/lib/precondicao-banco';
import {
  type DadosNuvem,
  gerarSqlNuvem,
  lerArquivoDadosNuvem,
  lerDadosNuvem,
  separarFlagsNuvem,
} from '../scripts/lib/transporte-nuvem';
import { gitBytes } from '../scripts/pendencias-prompt';

const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');
const RAIZ = join(import.meta.dirname, '..');
const BASELINE = join(RAIZ, 'db', 'deriva-corpo-baseline.json');

/** Quem consome a resposta da nuvem: a gerada para outro CLI é recusada como "arquivo de outra leitura". */
export const CONSUMIDOR_NUVEM = 'deriva-corpo';

const USO = 'Uso: bun run deriva:corpo:prod [--sem-rede] [--sql-nuvem | --dados-nuvem=<arquivo>]';

/** "Não medi" (exit 2), lançado de qualquer ponto e convertido UMA vez, em `executar`. */
class MedicaoIncompleta extends Error {}

/** Erro de EXECUÇÃO: exit 2. Sem nenhum `✅` — "não medi" não pode virar resumo verde no carimbo. */
function erroFatal(msg: string): never {
  throw new MedicaoIncompleta(msg);
}

export interface Entrada {
  lidas: MigrationLida[];
  baseline: EntradaBaseline[];
  sha: string;
  fetch: boolean;
}

/** O que o mundo dá ao audit — injetado para o teste medir os dois caminhos com a MESMA prod. */
export interface Dependencias {
  /** O repo (git ou fixture). `aviso` recebe o que sai antes do veredito. */
  carregarEntrada: (semRede: boolean, aviso: (linha: string) => void) => Entrada;
  /** O `psql-ro` (`-q -v ON_ERROR_STOP=1 -tA -F '|' -c`): SQL → stdout. Falha LANÇA. */
  psql: (sql: string) => string;
  /** O conteúdo do arquivo do `--dados-nuvem`. */
  lerArquivo: (caminho: string) => string;
  agora: () => Date;
}

export interface Execucao {
  exit: 0 | 1 | 2;
  saida: string[];
  erro: string[];
}

/**
 * O texto que o `psql -q -tA -F '|'` imprime para `BEGIN; <sonda>; <detalhe>; COMMIT;` — medido no
 * psql 17: os result sets em sequência, cada linha terminada em `\n`, e NADA para result set vazio
 * (nem separador, nem rodapé). É o que o parser do caminho local recebe; o da nuvem recebe o mesmo.
 */
export function saidaComoPsql(dados: DadosNuvem): string {
  // A receita mora na lib (`saidaDerivaComoPsql`) porque o pacote do gate de deploy também lê esta
  // sonda pela nuvem; aqui só se mantém o "não medi" com a cara do audit (exit 2 com o motivo).
  try {
    return saidaDerivaComoPsql(dados.linhas);
  } catch (e) {
    throw new MedicaoIncompleta(mensagemDeErro(e) ?? 'transporte da nuvem: resposta incompleta');
  }
}

function medir(argv: readonly string[], deps: Dependencias, saida: string[], erro: string[]): 0 | 1 | 2 {
  let nuvem: ReturnType<typeof separarFlagsNuvem>;
  try {
    nuvem = separarFlagsNuvem(argv);
  } catch (e) {
    erroFatal(`${mensagemDeErro(e) ?? 'flags da nuvem ilegíveis'}. ${USO}`);
  }
  const desconhecidos = nuvem.resto.filter((a) => a !== '--sem-rede');
  if (desconhecidos.length > 0) erroFatal(`argumento desconhecido: ${desconhecidos.join(' ')}. ${USO}`);

  // Na 1ª rodada da nuvem o stdout É o SQL que o modelo copia verbatim: aviso nenhum pode cair nele.
  const aviso = nuvem.sqlNuvem ? (l: string) => erro.push(l) : (l: string) => saida.push(l);
  const { lidas, baseline, sha, fetch } = deps.carregarEntrada(nuvem.resto.includes('--sem-rede'), aviso);

  const modelo = modelarRepo(lidas);
  const historico = historicoDeCorpos(lidas);
  const alvos = [...modelo.nomes].sort((a, b) => a.localeCompare(b, 'en')).map((rpc) => ({ rpc, edges: [] as string[] }));
  if (alvos.length === 0) erroFatal('o repo não define função `public` nenhuma — é leitura quebrada, não universo vazio');
  const nomes = [...new Set([...alvosDeCorpo(alvos, historico), ...modelo.nomes])];
  // A sonda recusa nome fora do alfabeto `[a-z0-9_]` em vez de escapar — e isso é "não medi".
  const consultas = consultasDeriva(nomes);

  // A 1ª metade do transporte: só o texto — quem o executa é o modelo, pelo `query_database`.
  if (nuvem.sqlNuvem) {
    saida.push(gerarSqlNuvem(consultas, CONSUMIDOR_NUVEM));
    return 0;
  }

  let bruta: string;
  if (nuvem.dadosNuvem === null) {
    bruta = deps.psql(montarSondaDeriva(nomes));
  } else {
    let dados: DadosNuvem;
    try {
      dados = lerDadosNuvem(deps.lerArquivo(nuvem.dadosNuvem), { consultas, consumidor: CONSUMIDOR_NUVEM }, deps.agora());
    } catch (e) {
      erroFatal(`transporte da nuvem: ${mensagemDeErro(e) ?? 'resposta ilegível'}`);
    }
    bruta = saidaComoPsql(dados);
  }

  // Daqui para baixo o juízo não sabe de onde veio a linha — é o ponto: o transporte não pode
  // virar outro juiz.
  const leitura = parsearSondaDeriva(bruta);
  // O veredito do gate do pacote sobre a MESMA sonda: os controles fail-closed dele (marcador,
  // controle positivo, dialeto, inventário) valem aqui sem reimplementação.
  // O canal de texto vai junto: o gate re-testa por tokens o que o md5 chama de DERIVA, e sem ele
  // diria INCERTA. Para o audit nada muda — ele só lê o INCERTA dos controles, e um canal quebrado
  // já é incerteza do próprio `julgarDeriva`.
  const controles = julgarPrecondicao(
    alvos,
    leitura.sonda,
    0,
    {
      historico,
      inventarioDaRef: lidas.length,
      migrationsLidas: lidas.length,
      funcoesConhecidas: historico.size,
    },
    textosDaLeitura(leitura),
  );
  const resultado = julgarDeriva({ modelo, leitura, baseline, controles });
  const relatorio = relatarDeriva(resultado, { sha, fetch, agora: leitura.agora });
  saida.push(...relatorio.saida);
  erro.push(...relatorio.erro);
  return resultado.exit;
}

/** A execução inteira, com o mundo injetado. Nunca lança: toda falha vira exit 2 com o motivo. */
export function executar(argv: readonly string[], deps: Dependencias): Execucao {
  const saida: string[] = [];
  const erro: string[] = [];
  let exit: 0 | 1 | 2;
  try {
    exit = medir(argv, deps, saida, erro);
  } catch (e) {
    // Exceção INESPERADA em qualquer ponto é "não medi" (2). Deixá-la escapar daria o exit 1 cru do
    // bun — e o carimbo leria 1 como "prod divergiu", um achado inventado.
    const motivo =
      e instanceof MedicaoIncompleta ? e.message : `exceção inesperada: ${mensagemDeErro(e) ?? 'erro desconhecido'}`;
    erro.push(`⛔ [INCERTO] ${motivo}`, '⛔ deriva-corpo — medição INCOMPLETA: nada acima é veredito sobre prod');
    exit = 2;
  }
  return { exit, saida, erro };
}

function carregarEntradaReal(semRede: boolean, aviso: (linha: string) => void): Entrada {
  const teste = process.env.AUTHZ_DERIVA_CORPO_TEST_JSON;
  if (teste) {
    aviso('⚠️  entrada de TESTE (AUTHZ_DERIVA_CORPO_TEST_JSON) — não é o repo real.');
    const obj = JSON.parse(readFileSync(teste, 'utf8')) as { migrations: MigrationLida[]; baseline: unknown };
    // A MESMA ordem do caminho real (`migrationsDaRef`: lexical do nome) — a fixture não impõe outra.
    const lidas = [...obj.migrations].sort((a, b) => a.nome.localeCompare(b.nome, 'en'));
    return { lidas, baseline: lerBaseline(JSON.stringify(obj.baseline)), sha: 'sintetico', fetch: false };
  }
  const git = gitBytes(RAIZ);
  if (!semRede) {
    const f = git(['fetch', 'origin', 'main', '--quiet']);
    if (!f.ok) {
      erroFatal(
        `git fetch falhou (${f.erro.trim() || 'sem stderr'}) — sem a ref atual, "bate" seria contra ` +
          'expectativa velha; `--sem-rede` mede assim mesmo, e o denominador o declara',
      );
    }
  }
  const rev = git(['rev-parse', '--verify', 'origin/main^{commit}']);
  if (!rev.ok) erroFatal(`git rev-parse origin/main falhou: ${rev.erro.trim() || 'sem stderr'}`);
  const sha = rev.bytes.toString('utf8').trim();
  return {
    lidas: migrationsDaRef(git, sha),
    baseline: lerBaseline(readFileSync(BASELINE, 'utf8')),
    sha,
    fetch: !semRede,
  };
}

function psqlReal(sql: string): string {
  try {
    // `-c` (não `-f`): só `-c` sai ≠ 0 em ERROR pelo wrapper; `-q` cala os `SET` do psqlrc.
    return execFileSync(PSQL, ['-q', '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '|', '-c', sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string };
    erroFatal(`psql-ro saiu ${err.status ?? '?'}: ${(err.stderr ?? mensagemDeErro(e) ?? '').trim().slice(0, 300)}`);
  }
}

if (import.meta.main) {
  const r = executar(process.argv.slice(2), {
    carregarEntrada: carregarEntradaReal,
    psql: psqlReal,
    lerArquivo: lerArquivoDadosNuvem,
    agora: () => new Date(),
  });
  for (const l of r.saida) console.log(l);
  for (const l of r.erro) console.error(l);
  process.exit(r.exit);
}
