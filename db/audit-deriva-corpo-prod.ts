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
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { mensagemDeErro } from '@/lib/erro-mensagem';

import { historicoDeCorpos, type MigrationLida } from '../scripts/lib/corpo-esperado';
import {
  type EntradaBaseline,
  julgarDeriva,
  lerBaseline,
  modelarRepo,
  montarSondaDeriva,
  parsearSondaDeriva,
  relatarDeriva,
} from '../scripts/lib/deriva-corpo';
import { migrationsDaRef } from '../scripts/lib/migrations-da-ref';
import { alvosDeCorpo, julgarPrecondicao } from '../scripts/lib/precondicao-banco';
import { gitBytes } from '../scripts/pendencias-prompt';

const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');
const RAIZ = join(import.meta.dirname, '..');
const BASELINE = join(RAIZ, 'db', 'deriva-corpo-baseline.json');

/** Erro de EXECUÇÃO: exit 2. Sem nenhum `✅` — "não medi" não pode virar resumo verde no carimbo. */
function erroFatal(msg: string): never {
  console.error(`⛔ [INCERTO] ${msg}`);
  console.error('⛔ deriva-corpo — medição INCOMPLETA: nada acima é veredito sobre prod');
  process.exit(2);
}

interface Entrada {
  lidas: MigrationLida[];
  baseline: EntradaBaseline[];
  sha: string;
  fetch: boolean;
}

function carregarEntrada(semRede: boolean): Entrada {
  const teste = process.env.AUTHZ_DERIVA_CORPO_TEST_JSON;
  if (teste) {
    console.log('⚠️  entrada de TESTE (AUTHZ_DERIVA_CORPO_TEST_JSON) — não é o repo real.');
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

function medir(semRede: boolean): 0 | 1 | 2 {
  const { lidas, baseline, sha, fetch } = carregarEntrada(semRede);

  const modelo = modelarRepo(lidas);
  const historico = historicoDeCorpos(lidas);
  const alvos = [...modelo.nomes].sort((a, b) => a.localeCompare(b, 'en')).map((rpc) => ({ rpc, edges: [] as string[] }));
  if (alvos.length === 0) erroFatal('o repo não define função `public` nenhuma — é leitura quebrada, não universo vazio');
  const nomes = [...new Set([...alvosDeCorpo(alvos, historico), ...modelo.nomes])];
  // A sonda recusa nome fora do alfabeto `[a-z0-9_]` em vez de escapar — e isso é "não medi".
  const sql = montarSondaDeriva(nomes);

  let saida: string;
  try {
    // `-c` (não `-f`): só `-c` sai ≠ 0 em ERROR pelo wrapper; `-q` cala os `SET` do psqlrc.
    saida = execFileSync(PSQL, ['-q', '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '|', '-c', sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string };
    erroFatal(`psql-ro saiu ${err.status ?? '?'}: ${(err.stderr ?? mensagemDeErro(e) ?? '').trim().slice(0, 300)}`);
  }

  const leitura = parsearSondaDeriva(saida);
  // O veredito do gate do pacote sobre a MESMA sonda: os controles fail-closed dele (marcador,
  // controle positivo, dialeto, inventário) valem aqui sem reimplementação.
  const controles = julgarPrecondicao(alvos, leitura.sonda, 0, {
    historico,
    inventarioDaRef: lidas.length,
    migrationsLidas: lidas.length,
    funcoesConhecidas: historico.size,
  });
  const resultado = julgarDeriva({ modelo, leitura, baseline, controles });
  const { saida: linhas, erro } = relatarDeriva(resultado, { sha, fetch, agora: leitura.agora });
  for (const l of linhas) console.log(l);
  for (const l of erro) console.error(l);
  return resultado.exit;
}

function main(): void {
  let exit: 0 | 1 | 2;
  try {
    exit = medir(process.argv.includes('--sem-rede'));
  } catch (e) {
    // Exceção INESPERADA em qualquer ponto é "não medi" (2). Deixá-la escapar daria o exit 1 cru do
    // bun — e o carimbo leria 1 como "prod divergiu", um achado inventado.
    erroFatal(`exceção inesperada: ${mensagemDeErro(e) ?? 'erro desconhecido'}`);
  }
  process.exit(exit);
}

main();
