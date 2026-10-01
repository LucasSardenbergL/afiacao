#!/usr/bin/env bun
/**
 * relogio-nu-da-sessao-gate.ts — fiscal TEXTUAL do DIA da sessão lido NU (fora de date_trunc): a
 * classe (ii) do fuso da sessão. Não executa SQL nenhum.
 *
 *   bun scripts/relogio-nu-da-sessao-gate.ts          # o repo (pisos, corte, baseline dos corpos vivos)
 *   bun scripts/relogio-nu-da-sessao-gate.ts <dir…>   # corpo arbitrário (sem piso, corte nem baseline — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (piso de denominador furado,
 * stripper desabando, cerca de markdown que não fecha). 2 NUNCA é "passou".
 * Roda no CI pelo vitest (`relogio-nu-da-sessao-gate.test.ts`); as mutações que provam o dente de cada
 * camada estão em `scripts/mutcheck.d/relogio-nu-da-sessao.mut`.
 *
 * ## A classe (docs/historico/hoje-da-sessao-nu-funcoes-e-skills.md)
 *
 * A prod roda sessão UTC (e o psql-ro das skills também). `current_date`, `now()::date` e o instante
 * que vira data por `::date` usam o fuso da SESSÃO: das 21:00 às 23:59 BRT dão o dia SEGUINTE ao de São
 * Paulo. A classe (i) — o mesmo relógio truncado por `date_trunc` — tem o irmão
 * `fuso-da-sessao-em-migrations-e-skills-gate.ts`; aqui é a leitura NUA.
 *
 * ## A assinatura
 *
 * O dia da sessão (`current_date`, `localtimestamp`/`localtime`/`current_time`, o relógio `now()`/
 * `current_timestamp`/`clock_timestamp()`… convertido a `date`/`timestamp` por `::` — colado, ou depois de
 * aritmética de intervalo, `(now() - '6 mons'::interval)::date` —, `CAST`, `date()`,
 * `to_char` ou `extract`/`date_part` de campo de calendário) e o instante que vira data na sessão (a
 * coluna `*_at`/`*_em` — a convenção de timestamptz que o irmão de SP mediu em 92,4% da prod, menos os
 * 3 `*_em` que são `date` — por `::date`/`::timestamp`, `date()`, `CAST`, `min/max(…)::date`,
 * `date_trunc` de 2 argumentos, `extract` ou `to_char`). O conserto escreve o fuso na expressão, e o
 * fuso pedido é o EXPLÍCITO: quem mede em UTC de propósito escreve `(now() AT TIME ZONE 'UTC')::date` e
 * passa. Comentário sai pelo stripper COMPARTILHADO; prosa de `.md` fica de fora (só as cercas).
 *
 * ## Os universos
 *
 *   · as skills: os `.sql` inteiros e TODA cerca dos `.md` — limpas, sem baseline (medido em
 *     2026-09-29: 53 sítios em 10 arquivos, todos consertados na mesma leva; o falso-positivo das
 *     consultas de skill é ~0, e o que era UTC de propósito — as horas do cron no diagnóstico de sync
 *     — passou a escrever o UTC);
 *   · as migrations a partir do CORTE, o TEXTO INTEIRO (função com ou sem SP, view, `cron.schedule`,
 *     `DO`, DEFAULT) — limpas, sem baseline. Antes do corte há ~290 sítios em definições que valeram
 *     um dia; migration é imutável, e o que importa delas é o corpo que vale HOJE — o 3º universo;
 *   · os corpos VIVOS de função (a última definição de cada identidade, `modelarRepo`): o que resta
 *     da classe é BASELINE com veredito por sítio, e a lista só encolhe — sítio novo reprova, entrada
 *     quitada que fica reprova. Nos corpos, 44% dos sítios eram UTC-consistentes (o outro lado da
 *     comparação também é UTC): é por isso que a baseline guarda o VEREDITO, não só o trecho.
 *
 * ## LIMITES DECLARADOS (quem pega é a varredura da prod por psql-ro, ou a prova executada)
 *   · o que só existe na PROD — função, view ou DEFAULT criados fora de migration (9 das 26
 *     funções que casaram na varredura de 2026-09-28 viviam só lá);
 *   · SQL montado em string (`EXECUTE format(...)`), e timestamptz fora da convenção `*_at`/`*_em`;
 *   · a borda contra TIMESTAMPTZ montada com o dia já certo: `t2_data_faturamento >= (dia_sp - '180 days')`
 *     compara timestamptz com timestamp SEM fuso, e o cast implícito usa o fuso da SESSÃO — o tipo da
 *     coluna não está no texto (v_sku_leadtime_estatisticas, fase 2: a borda é o INSTANTE da meia-noite
 *     de SP, `(dia_sp - '180 days') AT TIME ZONE 'America/Sao_Paulo'`);
 *   · literal que CITA a forma errada conta como código (o stripper só tira comentário): numa POS,
 *     escreva a agulha partida — `'created' || '_at::date'` — ou com `\m` na frente, como a
 *     20260929001651.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Arquivo, TETO_BLOCO_DESCARTADO, corposVivosDe, lerRepo } from './fuso-da-sessao-em-migrations-e-skills-gate';
import { somenteCercas } from './lib/markdown-codigo';
import { maiorBlocoDescartadoSql, removerComentariosSql } from './lib/sql-comentarios';

export { lerRepo, corposVivosDe, type Arquivo };

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => fileURLToPath(new URL('..', import.meta.url));

/**
 * Migrations a partir daqui são lidas INTEIRAS. É o início da cauda limpa medida em 2026-09-29: as duas
 * migrations da noite de 27/09 (positivação canônica e a classe (i)) já não liam o dia da sessão.
 */
export const CORTE = '20260927195430';

export const PISOS = {
  /** Migrations lidas — zero é leitura quebrada, nunca "repo sem DDL". Eram 743 em 2026-09-29. */
  migrations: 700,
  /** Migrations a partir do CORTE — o denominador do 2º universo. Eram 2 no nascimento do gate. */
  migracoesNovas: 2,
  /** Arquivos de skill lidos (`.sql` + `.md`). Eram 46. */
  arquivosDeSkill: 40,
  /** Linhas de CÓDIGO de skill lidas (`.sql` + cercas). Eram 2.303: abrir arquivo não é ler consulta. */
  linhasDeCodigoDeSkill: 2000,
  /** Corpos vivos de função — o denominador do 3º universo. Eram 314. */
  corposVivos: 290,
} as const;

// Coluna timestamptz pela CONVENÇÃO de nome — a mesma do irmão de SP (scripts/fuso-da-sessao-gate.ts):
// `*_at`/`*_em`, menos os 3 `*_em` que na prod são `date`.
const COL = String.raw`(?:[a-z_][a-z0-9_]*\.)?(?!(?:inicio_em|medido_em|suspensa_em)\b)[a-z_][a-z0-9_]*_(?:at|em)`;
/** Não pode vir colado a identificador, ponto ou `::` — senão `x.y_at` casaria só o `y_at`. */
const ANTES = String.raw`(?<![a-z0-9_$.:])`;
const RELOGIO = String.raw`(?:now\s*\(\s*\)|current_timestamp|(?:clock|statement|transaction)_timestamp\s*\(\s*\))`;
/** `date`, ou `timestamp` SEM fuso (`timestamptz` e `timestamp with time zone` não convertem). */
const SEM_FUSO = String.raw`(?:date|timestamp)\b(?!\s*with\b)`;
const CAMPO = String.raw`'?(?:day|dow|isodow|doy|week|month|quarter|year|isoyear|hour)'?`;

export type Forma = 'dia da sessão' | 'instante→data na sessão';

const FORMAS: readonly { forma: Forma; re: RegExp }[] = [
  { forma: 'dia da sessão', re: /\b(?:current_date|localtimestamp|localtime|current_time)\b/gi },
  { forma: 'dia da sessão', re: new RegExp(String.raw`\b${RELOGIO}\s*::\s*${SEM_FUSO}`, 'gi') },
  // O relógio com aritmética de intervalo ANTES do cast: `(now() - '6 mons'::interval)::date` — o dia da
  // sessão do mesmo jeito, só que deslocado. Achado na varredura da prod da fase 2 (v_caca_candidatos, o
  // ativo_6m): a assinatura acima exige o `::` colado ao relógio e não o via.
  { forma: 'dia da sessão', re: new RegExp(String.raw`\(\s*${RELOGIO}\s*[-+][^()]*(?:\([^()]*\)[^()]*)*\)\s*::\s*${SEM_FUSO}`, 'gi') },
  { forma: 'dia da sessão', re: new RegExp(String.raw`\bcast\s*\(\s*${RELOGIO}\s+as\s+${SEM_FUSO}`, 'gi') },
  { forma: 'dia da sessão', re: new RegExp(String.raw`\bdate\s*\(\s*${RELOGIO}\s*\)`, 'gi') },
  { forma: 'dia da sessão', re: new RegExp(String.raw`\bto_char\s*\(\s*${RELOGIO}\s*,`, 'gi') },
  { forma: 'dia da sessão', re: new RegExp(String.raw`\b(?:extract\s*\(\s*${CAMPO}\s+from|date_part\s*\(\s*${CAMPO}\s*,)\s*${RELOGIO}\s*\)`, 'gi') },
  { forma: 'instante→data na sessão', re: new RegExp(String.raw`${ANTES}${COL}\s*::\s*${SEM_FUSO}`, 'gi') },
  { forma: 'instante→data na sessão', re: new RegExp(String.raw`\b(?:min|max)\s*\(\s*${COL}\s*\)\s*::\s*${SEM_FUSO}`, 'gi') },
  { forma: 'instante→data na sessão', re: new RegExp(String.raw`\b(?:date\s*\(\s*${COL}\s*\)|cast\s*\(\s*${COL}\s+as\s+${SEM_FUSO})`, 'gi') },
  { forma: 'instante→data na sessão', re: new RegExp(String.raw`\bdate_trunc\s*\(\s*'(?:day|week|month|quarter|year)'\s*,\s*${COL}\s*\)`, 'gi') },
  { forma: 'instante→data na sessão', re: new RegExp(String.raw`\bextract\s*\(\s*${CAMPO}\s+from\s+${COL}\s*\)`, 'gi') },
  { forma: 'instante→data na sessão', re: new RegExp(String.raw`\bto_char\s*\(\s*${COL}\s*,`, 'gi') },
];

const normalizar = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

export interface Sitio {
  arquivo: string;
  linha: number;
  /** O trecho casado, em minúscula e com espaço colapsado — a identidade do sítio na baseline. */
  trecho: string;
  forma: Forma;
}

/** Os sítios num texto SQL. A limpeza de comentário é daqui; a numeração de linha é a do texto. */
export function detectarNoSql(arquivo: string, sqlCru: string): Sitio[] {
  const limpo = removerComentariosSql(sqlCru);
  const sitios: Sitio[] = [];
  for (const { forma, re } of FORMAS) {
    for (const m of limpo.matchAll(re)) {
      sitios.push({ arquivo, linha: limpo.slice(0, m.index).split('\n').length, trecho: normalizar(m[0]), forma });
    }
  }
  return sitios.sort((a, b) => a.linha - b.linha || a.trecho.localeCompare(b.trecho));
}

export type Veredito = 'afetado' | 'utc-consistente' | 'latente';

export interface SitioConhecido {
  /** `nome(tipos)` — a chave de identidade do `modelarRepo`. */
  alvo: string;
  trecho: string;
  /** Quantas vezes o trecho aparece no corpo vivo. Muda para MAIS = sítio novo; para MENOS = quitou. */
  n: number;
  veredito: Veredito;
  motivo: string;
}

// Os sítios da classe nos corpos VIVOS em 2026-09-29, cada um com veredito lido no corpo e medido na
// prod (varredura de 398 funções + chamadores, horários de cron e leitores). A lista só ENCOLHE.
// (Os "UTC contra UTC" da família data_ciclo eram falsos: a medição da fase 2 mostrou data_ciclo = dia de SP
// em 19 de 20 noites, e desde a 20261001023000 o edge também o grava assim. atualizar_parametros_numericos_skus
// e reposicao_pos_candidatos saíram com ela; _data_health_compute ficou com a #2698, que recria a função.)
export const CONHECIDOS: readonly SitioConhecido[] = [
  { alvo: 'analytics_outbox_purgar()', trecho: 'r.ocorrido_em::date', n: 1, veredito: 'latente',
    motivo: 'o dia é só chave de agrupamento de analytics_outbox_perda, que não tem leitor; cron 04:20 UTC' },
  { alvo: 'detectar_outliers_empresa(text)', trecho: 'current_date', n: 2, veredito: 'latente',
    motivo: 'só o cron detectar-outliers-diario, 07:30 UTC (04:30 BRT): o mesmo dia nos dois fusos' },
  { alvo: 'detectar_skus_sem_grupo(text)', trecho: 'current_date', n: 1, veredito: 'latente',
    motivo: 'só o cron detectar-outliers-diario, 07:30 UTC (04:30 BRT): o mesmo dia nos dois fusos' },
  { alvo: 'fin_audit_trigger()', trecho: 'current_date', n: 3, veredito: 'latente',
    motivo: 'fin_audit_log.period_ref não tem leitor (useAuditTrail ordena por changed_at; só um índice a usa)' },
  { alvo: 'reposicao_param_fila_sensor(text)', trecho: 'current_date', n: 5, veredito: 'utc-consistente',
    motivo: 'relê o próprio carimbo (reposicao_param_fila_log.medido_em = CURRENT_DATE); cron 11:45 UTC' },
  { alvo: 'reposicao_param_limbo_watchdog()', trecho: 'current_date', n: 2, veredito: 'utc-consistente',
    motivo: 'relê o próprio carimbo (reposicao_param_limbo_log.medido_em = CURRENT_DATE); cron 11:30 UTC' },
  { alvo: 'sugerir_negociacao_paralela_hoje(text,integer)', trecho: 'current_date', n: 4, veredito: 'latente',
    motivo: 'sem chamador desde a 20260606230000 (o cron saiu); os 3 valido_ate comparam com o próprio CURRENT_DATE' },
];

export interface Analise {
  /** Todos os arquivos lidos — em modo fixture, nenhum é migration nem skill pelo caminho. */
  arquivos: number;
  migrations: number;
  migracoesNovas: number;
  arquivosDeSkill: number;
  linhasDeCodigoDeSkill: number;
  corposVivos: number;
  /** Skills + migrations a partir do corte (+ fixtures): aqui não há baseline, todo sítio reprova. */
  violacoes: Sitio[];
  /** Por `alvo · trecho`, quantas vezes cada casamento apareceu nos corpos vivos. */
  contagemVivos: Map<string, number>;
  alarmes: string[];
}

const ehSkill = (c: string) => c.startsWith('.claude/skills/');
const ehMigration = (c: string) => c.startsWith('supabase/migrations/');
const nomeDe = (c: string) => c.split('/').pop() ?? c;

/** O código que um arquivo manda rodar: o `.sql` inteiro, ou só as cercas de um `.md`. */
function codigoDe(a: Arquivo): { codigo: string; alarme?: string } {
  if (!a.caminho.endsWith('.md')) return { codigo: a.fonte };
  const { texto, cercaAberta } = somenteCercas(a.fonte);
  return {
    codigo: texto,
    alarme: cercaAberta ? `${a.caminho}:${cercaAberta.linha}: cerca ${cercaAberta.marca} que não fecha — o resto do arquivo foi lido como código` : undefined,
  };
}

export function analisar(arquivos: readonly Arquivo[], corpos: ReadonlyMap<string, string> = new Map()): Analise {
  const r: Analise = {
    arquivos: arquivos.length, migrations: 0, migracoesNovas: 0, arquivosDeSkill: 0, linhasDeCodigoDeSkill: 0,
    corposVivos: corpos.size, violacoes: [], contagemVivos: new Map(), alarmes: [],
  };
  for (const a of arquivos) {
    const skill = ehSkill(a.caminho);
    if (ehMigration(a.caminho)) {
      r.migrations++;
      if (nomeDe(a.caminho).slice(0, 14) < CORTE) continue;   // antes do corte: vale o corpo vivo, não o texto
      r.migracoesNovas++;
    }
    const { codigo, alarme } = codigoDe(a);
    if (alarme) r.alarmes.push(alarme);
    if (skill) {
      r.arquivosDeSkill++;
      r.linhasDeCodigoDeSkill += codigo.split('\n').filter((l) => l.trim() !== '').length;
    }
    const teto = skill || a.caminho.endsWith('.md') ? TETO_BLOCO_DESCARTADO.skills : TETO_BLOCO_DESCARTADO.migrations;
    const bloco = maiorBlocoDescartadoSql(codigo);
    if (bloco > teto) r.alarmes.push(`${a.caminho}: o stripper descartou ${bloco} linhas seguidas (teto ${teto}) — comeu código?`);
    r.violacoes.push(...detectarNoSql(a.caminho, codigo));
  }
  for (const [alvo, corpo] of corpos) {
    for (const s of detectarNoSql(alvo, corpo)) {
      const k = `${alvo} · ${s.trecho}`;
      r.contagemVivos.set(k, (r.contagemVivos.get(k) ?? 0) + 1);
    }
  }
  return r;
}

/** Diferença entre os corpos vivos e a baseline: o que é NOVO e o que foi QUITADO. */
export function confrontar(contagem: ReadonlyMap<string, number>, conhecidos: readonly SitioConhecido[]) {
  const esperado = new Map(conhecidos.map((c) => [`${c.alvo} · ${c.trecho}`, c.n]));
  const novos: string[] = [];
  const quitados: string[] = [];
  for (const [k, n] of contagem) if ((esperado.get(k) ?? 0) < n) novos.push(`${k} (${n}× no corpo vivo, baseline ${esperado.get(k) ?? 0})`);
  for (const [k, n] of esperado) if ((contagem.get(k) ?? 0) < n) quitados.push(`${k} (baseline ${n}, corpo vivo ${contagem.get(k) ?? 0})`);
  return { novos, quitados };
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `stripper — ${a}`);
  if (r.arquivos === 0) furos.push('nenhum arquivo lido');
  if (comPisos) {
    if (r.migrations < PISOS.migrations) furos.push(`${r.migrations} migration(s) lida(s) < piso ${PISOS.migrations}`);
    if (r.migracoesNovas < PISOS.migracoesNovas) {
      furos.push(`${r.migracoesNovas} migration(s) a partir do corte ${CORTE} < piso ${PISOS.migracoesNovas} — o corte não leu nada?`);
    }
    if (r.arquivosDeSkill < PISOS.arquivosDeSkill) furos.push(`${r.arquivosDeSkill} arquivo(s) de skill < piso ${PISOS.arquivosDeSkill}`);
    if (r.linhasDeCodigoDeSkill < PISOS.linhasDeCodigoDeSkill) {
      furos.push(`${r.linhasDeCodigoDeSkill} linha(s) de código de skill < piso ${PISOS.linhasDeCodigoDeSkill} — abriu arquivo, mas não leu consulta?`);
    }
    if (r.corposVivos < PISOS.corposVivos) furos.push(`${r.corposVivos} corpo(s) vivo(s) < piso ${PISOS.corposVivos}`);
  }
  if (furos.length > 0) {
    return { codigo: 2, linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)] };
  }
  // Com baseline, os corpos vivos se confrontam com ela; sem ela (fixture), só os arquivos dados contam.
  const { novos, quitados } = comPisos ? confrontar(r.contagemVivos, CONHECIDOS) : { novos: [], quitados: [] };
  if (r.violacoes.length + novos.length + quitados.length > 0) {
    return {
      codigo: 1,
      linhas: [
        '❌ o DIA da sessão lido sem o fuso escrito (classe ii do fuso da sessão):',
        ...r.violacoes.map((s) => `  ${s.arquivo}:${s.linha} ${s.trecho} (${s.forma})`),
        ...novos.map((n) => `  CORPO VIVO NOVO ${n}`),
        ...quitados.map((q) => `  QUITADO (tire da baseline CONHECIDOS) ${q}`),
        '',
        '  A prod roda sessão UTC (e o psql-ro das skills também): das 21:00 às 23:59 BRT o dia da sessão já é o seguinte.',
        "  Conserto — o fuso NA EXPRESSÃO: (now() AT TIME ZONE 'America/Sao_Paulo')::date para a DATA de SP (coluna date);",
        "  (col AT TIME ZONE 'America/Sao_Paulo')::date para o instante que vira data; date_trunc('day', now(), 'America/Sao_Paulo')",
        "  para o INSTANTE da meia-noite de SP (comparar com timestamptz). UTC de propósito se escreve: now() AT TIME ZONE 'UTC'.",
        '  Corpo vivo que é UTC contra UTC de verdade entra na baseline com o veredito e o motivo medidos.',
        '  docs/historico/hoje-da-sessao-nu-funcoes-e-skills.md',
      ],
    };
  }
  const censo = comPisos
    ? ` (${r.migrations} migrations, ${r.migracoesNovas} a partir do corte ${CORTE}, ${r.arquivosDeSkill} arquivos de skill com ${r.linhasDeCodigoDeSkill} linhas de código, ${r.corposVivos} corpos vivos; ${CONHECIDOS.length} sítios conhecidos)`
    : ` (${r.arquivos} arquivo(s))`;
  return { codigo: 0, linhas: [`✅ dia da sessão em skills, migrations novas e corpos vivos${censo}: nenhum lido sem o fuso escrito fora da baseline.`] };
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    const { arquivos, corpos } = lerRepo(raizDoRepo());
    const { codigo, linhas } = veredito(analisar(arquivos, corpos), true);
    (codigo === 0 ? console.log : console.error)(linhas.join('\n'));
    return codigo;
  }
  // Modo fixture: cada caminho é um arquivo .sql/.md lido inteiro, sem corte nem baseline.
  const andar = (p: string, acc: string[] = []): string[] => {
    if (statSync(p).isDirectory()) for (const n of readdirSync(p).sort()) andar(join(p, n), acc);
    else if (/\.(sql|md)$/.test(p)) acc.push(p);
    return acc;
  };
  const arquivos = argv.flatMap((d) => andar(resolve(d))).map((p) => ({ caminho: relative(process.cwd(), p), fonte: readFileSync(p, 'utf8') }));
  const { codigo, linhas } = veredito(analisar(arquivos), false);
  (codigo === 0 ? console.log : console.error)(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
