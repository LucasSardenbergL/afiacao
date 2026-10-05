#!/usr/bin/env bun
/**
 * authz-carimbo-gravar.ts — RUNNER do carimbo. Roda os audits de prod sob `psql-ro` e grava a
 * evidência em `db/authz-carimbo-prod.json`. É o único escritor do carimbo.
 *
 * Uso:  bun run authz:carimbo:gravar ; echo $?   → 0 gravou · 2 não gravou (medição inválida)
 *
 * Só roda na máquina que tem a credencial (o CI não tem, e não deve ter). Quem CONSOME o carimbo
 * é `bun run authz:carimbo`, esse sim no CI. Racional completo: scripts/lib/authz-carimbo.ts.
 *
 * TRÊS invariantes que este runner sustenta, e cada uma existe por um modo de falha nomeado:
 *
 * 1. NÃO GRAVA MEDIÇÃO INVÁLIDA. `exit 2` de um audit é ERRO DE EXECUÇÃO, não resultado sobre
 *    produção. Se ele virasse carimbo, uma falha de rede renovaria a data e a idade recomeçaria do
 *    zero — o carimbo passaria a atestar "medi e está tudo bem" quando não mediu nada. Nesse caso
 *    o carimbo ANTERIOR fica intacto e a idade dele CONTINUA correndo, que é o comportamento certo.
 *
 * 2. NÃO GRAVA MEDIÇÃO DE OUTRO ALVO. Os audits aceitam `PSQL_RO` alternativo e allowlist de teste
 *    por env (`*_TEST_JSON`) — desenhado para o harness PG17. Rodar com qualquer um deles e
 *    carimbar produziria evidência sobre um banco/contrato que não é prod. O runner recusa os dois
 *    e ainda PINA o cluster: o hash do `system_identifier` da sonda tem de ser PROJETO_HASH_PROD
 *    (`conferirCluster`) — a constante do código, não o carimbo anterior, que o operador edita. O
 *    gate cobra o mesmo no artefato (revisão independente de 2026-10-05).
 *
 * 3. NÃO RESETA A IDADE DE UM ACHADO. `primeiraVez` é preservada por `id` do achado entre
 *    execuções. Sem isso, renovar o carimbo lavaria a dívida: um achado ficaria "conhecido e
 *    fresco" para sempre, e a re-execução viraria o mecanismo de esconder o problema.
 *
 * A invariante 3 depende de RELER o carimbo anterior — e ele é relido pela porta `lerCarimboAnterior`,
 * que confere a versão ANTES da forma e RECUSA com código, nunca por cast. Com cast, um anterior de
 * outro formato regredia a `primeiraVez` para hoje (docs/historico/carimbo-gravador-rele-por-porta.md).
 * Anterior recusado: exit 2, carimbo intocado. E o local não basta sozinho: o da `origin/main` (a cópia
 * que o CI lê, depois de um fetch) é a REFERÊNCIA — apagar o arquivo não zera a dívida, um local velho
 * não a regride, e main sem o carimbo é recusa, não nascimento (`combinarAnteriores`). A montagem do
 * carimbo novo (trava + herança) é pura e testada: `montarCarimbo`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import {
  AUDITS,
  CARIMBO_PATH,
  RAIZ,
  combinarAnteriores,
  conferirCluster,
  envDeTesteSetadas,
  fingerprintsAtuais,
  idFinding,
  lerArquivoDoCarimbo,
  lerCarimboAnterior,
  lerReferenciaDaMain,
  montarCarimbo,
  referenciaDoTexto,
  type Carimbo,
  type CarimboAnterior,
  type ReferenciaDaMain,
  type ChaveAudit,
  type ExecucaoDeAudit,
} from '../scripts/lib/authz-carimbo';

const PSQL_PADRAO = join(homedir(), '.config', 'afiacao', 'psql-ro');
const CARIMBO_REL = relative(RAIZ, CARIMBO_PATH);

function abortar(msg: string): never {
  console.error(`❌ ${msg}`);
  console.error('   O carimbo anterior NÃO foi tocado — a idade dele continua correndo.');
  process.exit(2);
}

/**
 * Sementes de `primeiraVez` para achados que já estavam ABERTOS antes de o carimbo existir.
 *
 * Sem isto o rollout dataria o `sales_orders` de hoje e apagaria a dívida acumulada desde
 * 2026-08-13 — o carimbo nasceria mentindo que o achado é novo. A data e a evidência estão em
 * docs/historico/sentinela-grants-tabelas-fechadas.md §"Achado 2". Semente é SÓ para o passado
 * pré-carimbo: achado novo se data sozinho, e esta tabela não deve crescer.
 */
const SEMENTE_PRIMEIRA_VEZ: Record<string, string> = {
  [idFinding('grants', '[DRIFT_PROD] public.sales_orders: anon tem INSERT,DELETE fora do permitido')]:
    '2026-08-13',
};

/**
 * O carimbo ANTERIOR local, pela porta — nunca por cast. Lido ANTES de tudo que toca prod: anterior
 * recusado significa que nada será gravado, então nem se sonda o alvo.
 *
 * 🧪 Costuras de TESTE: `AUTHZ_CARIMBO_ANTERIOR_TEST_JSON` (o local) e `AUTHZ_CARIMBO_MAIN_TEST_JSON`
 * (a referência) trocam o arquivo e o git pelo texto delas. As duas casam `envDeTesteSetadas`, então
 * `recusarEnvDeTeste()` — a guarda SEGUINTE às leituras — aborta o runner: costura nunca chega à
 * sonda nem à escrita, por construção. É o que deixa o teste do BINÁRIO exercer as portas sem
 * caminho até prod (scripts/authz-carimbo.test.ts).
 */
function lerAnteriorOuAbortar(): CarimboAnterior | null {
  const injetado = process.env.AUTHZ_CARIMBO_ANTERIOR_TEST_JSON;
  const arquivo = injetado ? { ok: true as const, texto: injetado } : lerArquivoDoCarimbo(CARIMBO_PATH);
  if (!arquivo.ok) abortar(`CARIMBO-ANTERIOR-RECUSADO ${arquivo.codigo} - ${arquivo.motivo}`);
  const leitura = lerCarimboAnterior(arquivo.texto);
  if (!leitura.ok) abortar(`CARIMBO-ANTERIOR-RECUSADO ${leitura.codigo} - ${leitura.motivo}`);
  return leitura.anterior;
}

function gitReal(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** O carimbo da `origin/main` — a referência (ver `combinarAnteriores`): sem ele, apagar o arquivo
 *  local pularia a trava, e um local velho regrediria a `primeiraVez` do que a main já viu. */
function lerReferenciaOuAbortar(): ReferenciaDaMain {
  const injetado = process.env.AUTHZ_CARIMBO_MAIN_TEST_JSON;
  const leitura = injetado ? referenciaDoTexto(injetado) : lerReferenciaDaMain(gitReal, CARIMBO_REL);
  if (!leitura.ok) abortar(`CARIMBO-ANTERIOR-RECUSADO ${leitura.codigo} - ${leitura.motivo}`);
  return leitura.referencia;
}

function recusarEnvDeTeste(): void {
  // A regra mora no núcleo PURO (`envDeTesteSetadas`), não aqui, porque aqui ela não é testável —
  // e porque ela era uma LISTA LITERAL de dois nomes que o audit de RLS já tinha ultrapassado.
  for (const v of envDeTesteSetadas(process.env)) {
    abortar(`${v} está setada — isso troca o CONTRATO por uma allowlist de teste. Carimbo tem de sair do contrato REAL.`);
  }
  const psql = process.env.PSQL_RO;
  if (psql && psql !== PSQL_PADRAO) {
    abortar(`PSQL_RO aponta para \`${psql}\`, não para o wrapper de prod (\`${PSQL_PADRAO}\`). Carimbo tem de medir PRODUÇÃO.`);
  }
}

interface Alvo {
  usuario: string;
  servidor: string;
  somenteLeitura: boolean;
  projetoHash: string;
}

/** Sonda de identidade do alvo. Fail-closed: sem resposta POSITIVA e parseável, não grava. */
function sondarAlvo(): Alvo {
  const q =
    "SELECT 'ALVO|'||current_user||'|'||substring(version() from 'PostgreSQL [0-9.]+')" +
    "||'|'||current_setting('transaction_read_only')||'|'||(SELECT system_identifier::text FROM pg_control_system());";
  let saida: string;
  try {
    saida = execFileSync(PSQL_PADRAO, ['-tA', '-c', q], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (e) {
    abortar(`sonda de alvo falhou via psql-ro: ${(e as Error).message}`);
  }
  const linha = saida.split('\n').find((l) => l.startsWith('ALVO|'));
  if (!linha) abortar(`sonda de alvo não devolveu linha ALVO| — saída inesperada, não vou adivinhar o alvo.`);
  const [, usuario, servidor, ro, sysid] = linha.trim().split('|');
  if (!usuario || !servidor || !sysid) abortar(`sonda de alvo veio incompleta: ${linha}`);
  return {
    usuario,
    servidor,
    somenteLeitura: ro === 'on',
    projetoHash: createHash('sha256').update(sysid).digest('hex').slice(0, 16),
  };
}

/**
 * Os fingerprints ANTES da sonda: são puros sobre o repo, e `canonicalizar` LANÇA por desenho em valor
 * exótico. Calculados depois dos audits (era assim até 2026-10-05), um erro aqui saía exit 1 — fora do
 * contrato 0/2 — depois de medir prod inteira.
 */
function fingerprintsOuAbortar(): ReturnType<typeof fingerprintsAtuais> {
  try {
    return fingerprintsAtuais();
  } catch (e) {
    abortar(`CARIMBO-RECUSADO CARIMBO_FINGERPRINT - nao consegui calcular os fingerprints de contrato/auditor: ${(e as Error).message}`);
  }
}

function rodarAudit(chave: ChaveAudit): ExecucaoDeAudit {
  const entry = AUDITS[chave].auditorFiles[0];
  let out = '';
  let exit = 0;
  try {
    out = execFileSync('bun', [entry], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    exit = typeof err.status === 'number' ? err.status : 2;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { exit, linhas: out.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '') };
}

/**
 * Escrita ATÔMICA: tmp + rename. Um Ctrl-C no meio do write deixaria um JSON truncado, e o gate
 * trataria isso como CARIMBO_AUSENTE — fail-closed, mas destruiria a evidência anterior à toa. Erro de
 * escrita (EACCES, disco cheio) é exit 2 com o `.tmp` removido — não exceção solta, exit 1.
 */
function gravarOuAbortar(carimbo: Carimbo): void {
  const tmp = `${CARIMBO_PATH}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(carimbo, null, 2)}\n`, 'utf8');
    renameSync(tmp, CARIMBO_PATH);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // o `.tmp` órfão não engana ninguém: o gate lê só o carimbo, que o rename não tocou
    }
    abortar(`CARIMBO-NAO-GRAVADO - a escrita falhou (${(e as NodeJS.ErrnoException).code ?? 'erro'}): ${(e as Error).message}`);
  }
  console.log(`\n📌 carimbo gravado em db/authz-carimbo-prod.json (medidoEm ${carimbo.medidoEm}).`);
  console.log('   Commite-o — é a evidência que o gate do CI lê.');
}

function main(): void {
  const combinados = combinarAnteriores(lerAnteriorOuAbortar(), lerReferenciaOuAbortar());
  if (!combinados.ok) abortar(`CARIMBO-ANTERIOR-RECUSADO ${combinados.codigo} - ${combinados.motivo}`);
  recusarEnvDeTeste();
  const fps = fingerprintsOuAbortar();
  const alvo = sondarAlvo();
  console.log(`🎯 alvo: ${alvo.usuario}@${alvo.servidor} · read-only=${alvo.somenteLeitura} · projeto ${alvo.projetoHash}`);

  // A trava ANTES de gastar os audits no banco errado. `montarCarimbo` a confere de novo e o gate a cobra
  // no artefato: esta linha é só a camada que falha mais cedo.
  const outroCluster = conferirCluster(alvo.projetoHash);
  if (outroCluster) abortar(`CARIMBO-RECUSADO ${outroCluster.codigo} - ${outroCluster.motivo}`);

  const agora = new Date().toISOString();
  const execucoes = {} as Record<ChaveAudit, ExecucaoDeAudit>;
  for (const chave of Object.keys(AUDITS) as ChaveAudit[]) {
    const { exit, linhas } = rodarAudit(chave);
    if (exit !== 0 && exit !== 1) {
      abortar(`\`${AUDITS[chave].script}\` saiu ${exit} (erro de EXECUÇÃO, não veredito sobre prod): ${linhas.join(' | ').slice(0, 400)}`);
    }
    const brutos = linhas.filter((l) => l.startsWith('❌')).length;
    if (exit === 1 && brutos === 0) {
      abortar(`\`${AUDITS[chave].script}\` saiu 1 mas não emitiu linha \`❌\` — não sei o que carimbar. Saída: ${linhas.join(' | ').slice(0, 400)}`);
    }
    execucoes[chave] = { exit, linhas };
    console.log(`${exit === 0 ? '✅' : '❌'} ${AUDITS[chave].script} → exit ${exit}${brutos ? ` · ${brutos} achado(s)` : ''}`);
  }

  let sourceHead: string | null = null;
  try {
    sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: RAIZ, encoding: 'utf8' }).trim();
  } catch {
    sourceHead = null; // informativo; ausência não invalida a medição
  }

  const montado = montarCarimbo({ alvo, execucoes, heranca: combinados.heranca, fps, agora, sourceHead, semente: SEMENTE_PRIMEIRA_VEZ });
  if (!montado.ok) abortar(`CARIMBO-RECUSADO ${montado.codigo} - ${montado.motivo}`);
  gravarOuAbortar(montado.carimbo);
}

main();
