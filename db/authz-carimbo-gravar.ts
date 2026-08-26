#!/usr/bin/env bun
/**
 * authz-carimbo-gravar.ts — RUNNER do carimbo. Roda os 3 audits de prod sob `psql-ro` e grava a
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
 *    por env (`AUTHZ_*_TEST_JSON`) — desenhado para o harness PG17. Rodar com qualquer um deles e
 *    carimbar produziria evidência sobre um banco/contrato que não é prod. O runner recusa os dois
 *    e ainda PINA o cluster: grava o hash do `system_identifier` e se recusa a sobrescrever um
 *    carimbo cujo alvo era outro cluster.
 *
 * 3. NÃO RESETA A IDADE DE UM ACHADO. `primeiraVez` é preservada por `id` do achado entre
 *    execuções. Sem isso, renovar o carimbo lavaria a dívida: um achado ficaria "conhecido e
 *    fresco" para sempre, e a re-execução viraria o mecanismo de esconder o problema.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AUDITS,
  CARIMBO_PATH,
  RAIZ,
  SCHEMA_VERSION,
  fingerprintAuditor,
  escolherResumo,
  fingerprintContrato,
  idFinding,
  type Achado,
  type Carimbo,
  type ChaveAudit,
  type ResultadoAudit,
} from '../scripts/lib/authz-carimbo';

const PSQL_PADRAO = join(homedir(), '.config', 'afiacao', 'psql-ro');

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

function recusarEnvDeTeste(): void {
  for (const v of ['AUTHZ_FUNCOES_TEST_JSON', 'AUTHZ_GRANTS_TEST_JSON']) {
    if (process.env[v]) {
      abortar(`${v} está setada — isso troca o CONTRATO por uma allowlist de teste. Carimbo tem de sair do contrato REAL.`);
    }
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

interface Execucao {
  exit: number;
  linhas: string[];
}

function rodarAudit(chave: ChaveAudit): Execucao {
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

function main(): void {
  recusarEnvDeTeste();
  const alvo = sondarAlvo();
  console.log(`🎯 alvo: ${alvo.usuario}@${alvo.servidor} · read-only=${alvo.somenteLeitura} · projeto ${alvo.projetoHash}`);

  const anterior: Carimbo | null = existsSync(CARIMBO_PATH)
    ? (JSON.parse(readFileSync(CARIMBO_PATH, 'utf8')) as Carimbo)
    : null;
  if (anterior && anterior.alvo?.projetoHash && anterior.alvo.projetoHash !== alvo.projetoHash) {
    abortar(
      `o carimbo existente foi medido no cluster ${anterior.alvo.projetoHash} e esta sessão está em ${alvo.projetoHash} — alvo diferente, não sobrescrevo.`,
    );
  }

  const agora = new Date().toISOString();
  const hoje = agora.slice(0, 10);
  const audits = {} as Record<ChaveAudit, ResultadoAudit>;

  for (const chave of Object.keys(AUDITS) as ChaveAudit[]) {
    const { exit, linhas } = rodarAudit(chave);
    if (exit !== 0 && exit !== 1) {
      abortar(`\`${AUDITS[chave].script}\` saiu ${exit} (erro de EXECUÇÃO, não veredito sobre prod): ${linhas.join(' | ').slice(0, 400)}`);
    }
    const achadosBrutos = linhas.filter((l) => l.startsWith('❌'));
    if (exit === 1 && achadosBrutos.length === 0) {
      abortar(`\`${AUDITS[chave].script}\` saiu 1 mas não emitiu linha \`❌\` — não sei o que carimbar. Saída: ${linhas.join(' | ').slice(0, 400)}`);
    }
    const achados: Achado[] = achadosBrutos.map((linha) => {
      const id = idFinding(chave, linha);
      const antes = anterior?.audits?.[chave]?.achados?.find((a) => a.id === id);
      return {
        id,
        linha,
        primeiraVez: antes?.primeiraVez ?? SEMENTE_PRIMEIRA_VEZ[id] ?? hoje,
        ultimaVez: hoje,
      };
    });
    audits[chave] = {
      script: AUDITS[chave].script,
      exit,
      resumo: escolherResumo(linhas),
      denominador: linhas.find((l) => l.startsWith('🔎'))?.slice(0, 300) ?? null,
      contratoFingerprint: fingerprintContrato(chave),
      auditorFingerprint: fingerprintAuditor(chave),
      achados,
    };
    const marca = exit === 0 ? '✅' : '❌';
    console.log(`${marca} ${AUDITS[chave].script} → exit ${exit}${achados.length ? ` · ${achados.length} achado(s)` : ''}`);
  }

  let sourceHead: string | null = null;
  try {
    sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: RAIZ, encoding: 'utf8' }).trim();
  } catch {
    sourceHead = null; // informativo; ausência não invalida a medição
  }

  const carimbo: Carimbo = { schemaVersion: SCHEMA_VERSION, medidoEm: agora, sourceHead, alvo, audits };

  // Escrita ATÔMICA: tmp + rename. Um Ctrl-C no meio do write deixaria um JSON truncado, e o gate
  // trataria isso como CARIMBO_AUSENTE — fail-closed, mas destruiria a evidência anterior à toa.
  const tmp = `${CARIMBO_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(carimbo, null, 2)}\n`, 'utf8');
  renameSync(tmp, CARIMBO_PATH);
  console.log(`\n📌 carimbo gravado em db/authz-carimbo-prod.json (medidoEm ${agora}).`);
  console.log('   Commite-o — é a evidência que o gate do CI lê.');
}

main();
