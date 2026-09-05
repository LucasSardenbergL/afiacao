#!/usr/bin/env bun
/**
 * pendencias-deploy.ts — CLI da varredura PASSIVA de deploy divergente.
 *
 * Lê o LEDGER `public.deploy_atestacoes` (∪ a janela viva de `net._http_response`) pelo wrapper
 * read-only e julga contra o que a main espera. Não dispara sonda, não escreve, não precisa de
 * secret: só do `psql-ro` e do git. Feito para virar cron e só falar quando algo diverge.
 *
 * O julgamento puro vive em `lib/pendencias-deploy.ts` (testável sem rede). Aqui fica só a borda:
 * shell, git, o esperado lido do repo e os códigos de saída.
 *
 * EXIT CODES — e o 2 é o que impede este script de virar teatro:
 *   0  nada pendente
 *   1  há pendência: P1 (deploy no PR) · P2 (leva agrupada; escalada após 7 d) · bundle incoerente ·
 *      bundle sem mapa · edge fora do mapa · eco sem fonte · NUNCA atestada — o relatório nomeia
 *      cada classe e imprime o comando da sonda para as que precisam dela
 *   2  MECÂNICA não confiável: psql falhou, ledger inexistente (migration não aplicada), coletor
 *      sem execução bem-sucedida nos últimos 45 min, mapa vazio ou desatualizado em relação à
 *      fonte, `versao.ts` ilegível, linha da saída que não casou o formato, ZERO observações.
 *      Zero aqui NÃO é "tudo limpo" — um cron que devolvesse 0 ensinaria o operador a ler
 *      silêncio como aprovação, que é exatamente o hábito que a varredura existe para desfazer.
 *
 * POR QUE O LEDGER, E NÃO SÓ A JANELA (2026-09-05): `pg_net.ttl = 6h`. Antes, cada sessão via
 * 47/54 edges "sem sonda na janela" e o relatório mandava o founder colar o SQL de sonda DE NOVO —
 * a prova de ontem valia zero hoje. O ledger é alimentado por cron (`deploy-atestacoes-colher`,
 * 15/15 min); a sonda humana passa a ser UMA por deploy (e a 1ª de edge nova), nunca por sessão.
 *
 * POR QUE NÃO HÁ CRON DE SONDA ATIVA: o desenho inicial tinha um (6/6h, allowlist das edges que
 * já responderam `probe:true`). O Codex derrubou: rollback pelo Lovable, restauração de projeto
 * ou recriação manual devolvem um bundle PRÉ-sensor, que ignora `probe` e roda o fluxo real — a
 * `monthly-report` mandaria e-mail para a base inteira, autorizada por uma linha histórica do
 * ledger. Sondar para descobrir se o sensor existe é executar o request que o bundle velho lê
 * como fluxo real; só um mecanismo que o bundle velho REJEITE antes de qualquer efeito (p.ex.
 * atestação por `OPTIONS`) tornaria a automação segura. Fica registrado como follow-up.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  edgesParaSondar,
  julgar,
  lerTolerancia,
  parsearObservacoes,
  type Contexto,
  type Esperado,
  type Estado,
  type Relatorio,
  type Veredito,
} from './lib/pendencias-deploy';
import { ARQ_MAPA, calcularTodos, lerMapaCommitado, RAIZ_EDGES } from './sonda-fingerprint';
import { git, lerNaRev } from './sonda-versao-bump-gate';
import { extrairVersao } from './sonda-versao-sql';

const PSQL_RO = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** A migration que cria o ledger — citada no erro quando a tabela não existe em prod. */
export const MIGRATION_LEDGER = '20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql';

/** Nome do cron do coletor (o mesmo da migration). */
export const CRON_COLETOR = 'deploy-atestacoes-colher';

/** O coletor roda de 15 em 15 min; 3 passagens perdidas é cron parado, não atraso. */
export const COLETOR_TOLERANCIA_MIN = 45;

/**
 * O que prod já disse sobre cada edge — a linha MAIS RECENTE por edge, de duas fontes:
 *
 * 1. o LEDGER (`public.deploy_atestacoes`), que guarda tudo que o coletor já copiou;
 * 2. a JANELA VIVA (`public.deploy_atestacoes_janela_viva()`), para o que respondeu nos últimos
 *    minutos e o coletor ainda não copiou (ele passa de 15 em 15 min).
 *
 * A definição de "observação válida" mora na função do banco — a MESMA que o coletor usa. Duas
 * cópias do filtro divergiriam em silêncio (o #2103 documentou o ponto cego do eco passivo, e o
 * script ficou cego por dias porque a query dele não acompanhou a doc).
 *
 * `DISTINCT ON (edge) ... ORDER BY observado_em DESC, request_id DESC`: o desempate por id é
 * obrigatório — em prod há respostas com `created` idêntico ao microssegundo (64031/64032), e sem
 * ele a escolha fica com o plano, não com o dado.
 *
 * A idade vem calculada pelo banco (`now() - observado_em`): o parse de timestamptz no cliente é
 * o tipo de detalhe que quebra por locale/offset, e a lib só precisa de um número.
 */
export const SQL = `
WITH tudo AS (
  SELECT request_id, edge, versao, fonte, via, observado_em
  FROM public.deploy_atestacoes
  UNION ALL
  SELECT request_id, edge, versao, fonte, via, observado_em
  FROM public.deploy_atestacoes_janela_viva()
)
SELECT DISTINCT ON (edge)
       edge, versao, fonte, via,
       to_char(observado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
       round((extract(epoch FROM (now() - observado_em)) / 3600.0)::numeric, 2)
FROM tudo
ORDER BY edge, observado_em DESC, request_id DESC;
`.trim();

/**
 * Saúde do coletor: minutos desde a última execução BEM-SUCEDIDA do cron. `cron.job_run_details`
 * é a única testemunha de que o ledger está sendo alimentado — o ledger cheio de ontem e o
 * coletor morto hoje têm a mesma cara vistos só pela tabela.
 */
export const SQL_SAUDE_COLETOR = `
SELECT coalesce(
  round((extract(epoch FROM (now() - max(d.end_time))) / 60.0)::numeric, 1)::text,
  'nunca')
FROM cron.job j
LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid AND d.status = 'succeeded'
WHERE j.jobname = '${CRON_COLETOR}';
`.trim();

function psql(sql: string): string {
  return execFileSync(PSQL_RO, ['-A', '-F', '|', '-t', '-c', sql], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function semChatter(saida: string): string[] {
  return saida
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== 'SET');
}

/**
 * O esperado por edge, lido do REPO: `fonte` do mapa commitado + `VERSAO` do `versao.ts`.
 *
 * LANÇA (⇒ exit 2) se o mapa não bate com a fonte recalculada, ou se algum `versao.ts` está
 * ausente/ilegível: esperado indeterminável não é "sem divergência" (achado do Codex — validar o
 * universo antes de julgar). O CI já garante os dois; aqui pega worktree suja ou atrasada.
 */
export function lerEsperados(raiz = process.cwd()): Record<string, Esperado> {
  const mapa = lerMapaCommitado(raiz);
  const recalculado = calcularTodos(raiz);
  const divergentes = Object.keys({ ...mapa, ...recalculado }).filter((e) => mapa[e] !== recalculado[e]);
  if (divergentes.length > 0) {
    throw new Error(
      `o mapa ${ARQ_MAPA} não bate com a fonte em ${divergentes.length} edge(s) (${divergentes
        .slice(0, 5)
        .join(', ')}${divergentes.length > 5 ? ', …' : ''}). Rode \`bun run sonda:fingerprint -- --write\` ` +
        'ou sincronize a worktree — julgar contra um esperado errado fabricaria veredito.',
    );
  }

  const esperados: Record<string, Esperado> = {};
  const ilegiveis: string[] = [];
  for (const [edge, fonte] of Object.entries(mapa)) {
    const arq = join(raiz, RAIZ_EDGES, edge, 'versao.ts');
    const versao = existsSync(arq) ? extrairVersao(readFileSync(arq, 'utf8')) : null;
    if (versao === null) {
      ilegiveis.push(edge);
      continue;
    }
    esperados[edge] = { fonte, versao };
  }
  if (ilegiveis.length > 0) {
    throw new Error(
      `\`export const VERSAO\` ilegível ou ausente em: ${ilegiveis.join(', ')}. Sem os dois ` +
        'marcadores o par (versao, fonte) não se julga.',
    );
  }
  return esperados;
}

/**
 * A worktree está atrás da main em `supabase/functions/`?
 *
 * O Lovable deploya a MAIN; o esperado lido daqui é a worktree. Medido no primeiro veredito real
 * (2026-09-05): a worktree estava 3 commits atrás, o `versao.ts` local dizia v1.6 e prod já
 * servia a v1.7 da main — saiu um P1 FALSO ("deploy pendente") de uma edge em dia. É o eixo
 * TEMPO/ÁRVORE de `fatia-de-deploy-envelhece.md` mordendo o próprio instrumento. A régua é
 * três-pontos (`HEAD...origin/main`): só o que a main tem e esta árvore não; uma branch que
 * ACRESCENTA edge continua julgável, uma branch ATRASADA não. Devolve a lista de arquivos da
 * main ausentes aqui — vazia = sincronizada. Sem `origin/main` resolvível, LANÇA.
 */
export function arquivosDeEdgeSoNaMain(): string[] {
  const ref = git(['rev-parse', '--verify', 'origin/main^{commit}']);
  if (!ref.ok) throw new Error('`origin/main` não resolve — sem a ref da main não sei se esta worktree está atrasada (git fetch origin)');
  const r = git(['diff', '--name-only', 'HEAD...origin/main', '--', RAIZ_EDGES]);
  if (!r.ok) throw new Error('`git diff HEAD...origin/main -- supabase/functions/` falhou');
  return r.saida.split('\n').filter((l) => l !== '');
}

/**
 * O contexto que só o git responde.
 *
 * `parCoerente`: o commit mais ANTIGO em que a entrada `"edge": "fonte"` aparece no mapa é onde
 * esse `fonte` ENTROU na main; o `versao.ts` naquele commit é a versão que coexistiu com ele —
 * `versao.ts` está no closure, então enquanto o `fonte` não mudar a versão também não muda. Se o
 * `fonte` observado nunca esteve no mapa, o bundle não veio de commit nenhum da main.
 *
 * `diasPendente`: o commit mais RECENTE em que a entrada esperada aparece é onde ela entrou (ela é
 * a atual, logo nunca saiu); a idade dele é há quanto tempo a pendência existe.
 */
export function contextoGit(): Contexto {
  const agulha = (edge: string, fonte: string) => `-S"${edge}": "${fonte}"`;
  return {
    parCoerente(edge, versao, fonte) {
      const r = git(['log', '--format=%H', agulha(edge, fonte), '--', ARQ_MAPA]);
      if (!r.ok) throw new Error(`git log -S falhou para ${edge} — sem git não há coerência a provar`);
      const commits = r.saida.split('\n').filter((c) => c !== '');
      if (commits.length === 0) return false;
      const entrou = commits[commits.length - 1];
      const texto = lerNaRev(entrou, `${RAIZ_EDGES}/${edge}/versao.ts`);
      return texto !== null && extrairVersao(texto) === versao;
    },
    diasPendente(edge, fonteEsperado) {
      const r = git(['log', '-1', '--format=%ct', agulha(edge, fonteEsperado), '--', ARQ_MAPA]);
      if (!r.ok || r.saida === '') return null;
      const ct = Number(r.saida);
      if (!Number.isFinite(ct)) return null;
      return Math.floor((Date.now() / 1000 - ct) / 86_400);
    },
  };
}

function idade(v: Veredito): string {
  if (v.idadeHoras === null) return '';
  if (v.idadeHoras < 1) return `há ${Math.round(v.idadeHoras * 60)} min`;
  if (v.idadeHoras < 48) return `há ${Math.round(v.idadeHoras)} h`;
  return `há ${Math.round(v.idadeHoras / 24)} d`;
}

function imprimir(rel: Relatorio): void {
  // Tipados como `Estado` de propósito: um estado novo na lib sem rótulo aqui — ou um nome
  // digitado errado — vira erro de compilação, não seção que some calada do relatório.
  const ordem: Estado[] = [
    'DIVERGE_P1',
    'INCOERENTE',
    'SEM_MAPA_NO_BUNDLE',
    'FORA_DO_MAPA',
    'DIVERGE_P2',
    'SEM_FONTE_NO_ECO',
    'NUNCA_ATESTADA',
    'CONFERE',
  ];
  const rotulo: Record<Estado, string> = {
    DIVERGE_P1: '🔴 P1 — DEPLOY PENDENTE declarado (versao bumpou): deploy no PR',
    INCOERENTE: '🔴 bundle INCOERENTE (par versao/fonte nunca existiu na main): deploy PARCIAL ou bundle de fora da main',
    SEM_MAPA_NO_BUNDLE: '🔴 BUNDLE SEM O MAPA (_shared/sonda-fingerprints.ts ficou para trás no deploy)',
    FORA_DO_MAPA: '🟠 prod serve edge que a main não mapeia',
    DIVERGE_P2: '🟡 P2 — DEPLOY PENDENTE não declarado (closure mudou sem bump): política = leva agrupada, escala após 7 d',
    SEM_FONTE_NO_ECO: '⚪ eco sem `fonte` — não prova o closure: sonde-a',
    NUNCA_ATESTADA: '⚪ NUNCA atestada (ausência de dado, NÃO é ok): precisa da 1ª sonda',
    CONFERE: '✅ confere',
  };

  for (const estado of ordem) {
    const grupo: Veredito[] = rel.vereditos.filter((v) => v.estado === estado);
    if (grupo.length === 0) continue;
    console.log(`\n${rotulo[estado]} — ${grupo.length}`);
    for (const v of grupo) {
      let det = '';
      switch (v.estado) {
        case 'DIVERGE_P1':
          det = `  prod ${v.versao} → main ${v.versaoEsperada} · pendente há ${v.diasPendente ?? '?'} d`;
          break;
        case 'DIVERGE_P2':
          det = `  ${v.versao} · fonte ${v.observado?.slice(0, 10)}… → ${v.esperado?.slice(0, 10)}… · pendente há ${v.diasPendente ?? '?'} d${v.escalada ? ' · ⚠️ ESCALADA' : ''}`;
          break;
        case 'INCOERENTE':
          det = `  prod (${v.versao}, ${v.observado?.slice(0, 10)}…) · main (${v.versaoEsperada}, ${v.esperado?.slice(0, 10)}…)`;
          break;
        case 'NUNCA_ATESTADA':
          det = '';
          break;
        default:
          det = `  ${v.versao ?? ''} · visto ${idade(v)} via ${v.via}`;
      }
      console.log(`   ${v.edge.padEnd(34)}${det}`);
    }
  }

  const sondar = edgesParaSondar(rel);
  if (sondar.length > 0) {
    console.log(
      `\n   → sonda (founder cola no SQL Editor): bun run sonda:sql ${sondar.join(' ')}` +
        '\n     A resposta entra no ledger em até 15 min (cron deploy-atestacoes-colher) e vale até o fonte da main mudar.',
    );
  }

  console.log(
    `\n─── cobertura: ${rel.totalObservadas}/${rel.totalMapeadas} edges mapeadas com atestação (ledger ∪ janela viva)`,
  );
  if (rel.foraDoMapaHistoricas.length > 0) {
    console.log(
      `    ${rel.foraDoMapaHistoricas.length} edge(s) só no histórico do ledger, sem observação fresca (main não mapeia): ${rel.foraDoMapaHistoricas.join(', ')}`,
    );
  }
}

export function main(): number {
  let tolerarNunca: boolean;
  try {
    tolerarNunca = lerTolerancia(process.env.PENDENCIAS_TOLERAR_NUNCA_ATESTADA);
  } catch (e) {
    console.error(`❌ MECÂNICA: ${(e as Error).message}`);
    return 2;
  }

  let esperados: Record<string, Esperado>;
  try {
    const atrasados = arquivosDeEdgeSoNaMain();
    if (atrasados.length > 0) {
      console.error(
        `❌ MECÂNICA: a main tem ${atrasados.length} arquivo(s) em ${RAIZ_EDGES}/ que esta worktree NÃO tem` +
          ` (${atrasados.slice(0, 3).join(', ')}${atrasados.length > 3 ? ', …' : ''}).\n` +
          '   Prod é a MAIN: julgar contra uma árvore atrasada fabrica P1 de edge em dia (medido 2026-09-05).\n' +
          '   Sincronize (`git fetch origin && git rebase origin/main`, ou `git pull --rebase`) e rode de novo.',
      );
      return 2;
    }
    esperados = lerEsperados();
  } catch (e) {
    console.error(`❌ MECÂNICA: esperado indeterminável — ${(e as Error).message}`);
    return 2;
  }
  if (Object.keys(esperados).length === 0) {
    console.error('❌ MECÂNICA: mapa de fingerprints VAZIO. Rode `bun run sonda:fingerprint`.');
    return 2;
  }

  let saudeBruta: string;
  let saida: string;
  try {
    saudeBruta = psql(SQL_SAUDE_COLETOR);
    saida = psql(SQL);
  } catch (e) {
    const err = e as Error & { stderr?: string | Buffer };
    const stderr = String(err.stderr ?? '');
    // ASCII em caixa fixa de propósito: `exist` casa "does not exist" E "não existe" (o psql de
    // prod fala português) sem depender de acento nem de `-i` (lição #1483).
    if (stderr.includes('deploy_atestacoes') && stderr.includes('exist')) {
      console.error(
        `❌ MECÂNICA: o ledger public.deploy_atestacoes NÃO existe em prod — a migration\n` +
          `   supabase/migrations/${MIGRATION_LEDGER} ainda não foi aplicada (SQL Editor do Lovable).`,
      );
      return 2;
    }
    console.error(`❌ MECÂNICA: '${PSQL_RO}' falhou — ${err.message}`);
    console.error('   Sem leitura de prod NÃO existe veredito. Isto não é "tudo limpo".');
    return 2;
  }

  const saude = semChatter(saudeBruta);
  const minutos = saude.length === 1 && saude[0] !== 'nunca' ? Number(saude[0]) : NaN;
  if (saude.length !== 1) {
    console.error(
      `❌ MECÂNICA: o cron '${CRON_COLETOR}' não existe em prod — a migration ${MIGRATION_LEDGER} não foi aplicada inteira.`,
    );
    return 2;
  }
  if (!Number.isFinite(minutos) || minutos > COLETOR_TOLERANCIA_MIN) {
    console.error(
      `❌ MECÂNICA: o coletor '${CRON_COLETOR}' não tem execução bem-sucedida há ${saude[0]} min` +
        ` (tolerância ${COLETOR_TOLERANCIA_MIN}). O ledger pode estar desatualizado — confira cron.job_run_details.`,
    );
    return 2;
  }

  const { observacoes, linhasIgnoradas } = parsearObservacoes(saida);
  if (linhasIgnoradas > 0) {
    console.error(
      `❌ MECÂNICA: ${linhasIgnoradas} linha(s) da saída do psql não casaram o formato — a linha descartada pode ser a divergência.`,
    );
    return 2;
  }

  let rel: Relatorio;
  try {
    rel = julgar(esperados, observacoes, contextoGit(), linhasIgnoradas);
  } catch (e) {
    console.error(`❌ MECÂNICA: ${(e as Error).message}`);
    return 2;
  }

  if (rel.totalObservadas === 0) {
    console.error(
      `❌ MECÂNICA: ZERO das ${rel.totalMapeadas} edges mapeadas tem atestação (ledger vazio E janela vazia).`,
    );
    console.error('   Isto é ausência de dado, não aprovação — dispare a 1ª leva com `bun run sonda:sql`.');
    return 2;
  }

  imprimir(rel);

  const nunca = rel.vereditos.filter((v) => v.estado === 'NUNCA_ATESTADA').length;
  const pendentes = tolerarNunca ? rel.totalPendentes - nunca : rel.totalPendentes;
  if (tolerarNunca && nunca > 0) {
    console.log(`\n⚠️  PENDENCIAS_TOLERAR_NUNCA_ATESTADA=1: ${nunca} nunca atestada(s) NÃO contam como pendência nesta execução.`);
  }
  return pendentes > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
