#!/usr/bin/env bun
/**
 * fuso-da-sessao-em-migrations-e-skills-gate.ts — fiscal TEXTUAL do relógio da SESSÃO truncado ao
 * calendário nos universos que os irmãos não leem. Não executa SQL nenhum.
 *
 *   bun scripts/fuso-da-sessao-em-migrations-e-skills-gate.ts          # o repo (pisos, baseline, corpos vivos)
 *   bun scripts/fuso-da-sessao-em-migrations-e-skills-gate.ts <dir…>   # corpo arbitrário (sem piso nem baseline — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (piso de denominador furado,
 * stripper desabando, cerca de markdown que não fecha, chamada que não fecha). 2 NUNCA é "passou".
 * Roda no CI pelo vitest (`fuso-da-sessao-em-migrations-e-skills-gate.test.ts`); as mutações que
 * provam o dente de cada camada estão em `scripts/mutcheck.d/fuso-da-sessao-em-migrations-e-skills.mut`.
 *
 * ## A classe (docs/historico/relogio-da-sessao-truncado-rpcs-e-views-des.md)
 *
 * A prod roda sessão UTC. `date_trunc('<calendário>', <relógio da sessão>)` sem o fuso escrito trunca
 * no fuso da SESSÃO: das 21:00 às 23:59 BRT o dia/semana/mês/trimestre já é o seguinte. Até
 * 20260927202603 isso vivia em 2 RPCs (uma sem menção nenhuma a SP), em 2 views e em 2 skills — e
 * nenhum irmão os lia: `fuso-da-sessao-gate.ts` mede só corpo de FUNÇÃO que menciona
 * America/Sao_Paulo, e `fuso-da-sessao-em-provas-gate.ts`, só o shell de `db/`.
 *
 * ## A assinatura — a do irmão das provas, importada
 *
 * A chamada é LIDA como o Postgres a lê (`lerArgumentos`) e julgada por `classificar`, os dois de
 * `fuso-da-sessao-em-provas-gate.ts`: um parser e uma assinatura para os três universos. Reprova a
 * unidade de CALENDÁRIO sobre o relógio LOCAL da sessão (`current_date`, `localtimestamp`,
 * `now()::date` — com ou sem fuso depois) e sobre o relógio `timestamptz` sem o fuso escrito. O fuso
 * pedido é o EXPLÍCITO: quem mede em UTC de propósito escreve `now() AT TIME ZONE 'UTC'` e passa.
 *
 * ## Os universos e as camadas
 *
 *   · `supabase/migrations/*.sql`, o TEXTO INTEIRO — função com ou sem SP, view, matview,
 *     `cron.schedule`, `DO`. Camada: `removerComentariosSql` no arquivo todo (SQL de ponta a ponta).
 *   · as skills: `.claude/skills/**` — os `.sql` inteiros e o CÓDIGO das cercas dos `.md`
 *     (`somenteCercas`, o inverso de `removerCercas`: a prosa, onde a skill EXPLICA a forma errada, fica
 *     de fora). TODA cerca, não só ```sql: medido em 2026-09-27, das 172 cercas das skills 83 são sql,
 *     56 bash e 24 sem linguagem, e a etiqueta não decide o que se cola num psql.
 *   · os corpos VIVOS de função (a última definição de cada identidade, `modelarRepo`): nenhum pode
 *     ter a classe — é o que mantém mortas as definições históricas da baseline.
 *
 * ## Baseline — só as definições MORTAS
 *
 * Migration é imutável: as 4 chamadas históricas (3 definições de fin_projecao_13_semanas e a de
 * radar_kpis, todas superadas por 20260927202603) seguem no texto para sempre. A lista só encolhe:
 * casamento novo reprova; entrada que sumiu do texto (arquivo apagado ou editado) reprova. E apagar a
 * migration que as supera não passa calado: o corpo vivo volta a ser o antigo, e o 3º universo acusa.
 *
 * ## LIMITES DECLARADOS (quem pega é a varredura da prod por psql-ro, ou a prova executada)
 *   · o que só existe na PROD — view criada pelo SQL Editor, comando de cron fora de migration: as 2
 *     views DES viveram assim até 20260927202603, sem CREATE no repo;
 *   · SQL montado em string (`EXECUTE format(...)`), unidade ou relógio vindos de variável;
 *   · a classe irmã, `current_date`/`now()::date` NUS (fora de date_trunc): medido em 2026-09-27, 15 dos
 *     34 sítios em corpo sem SP são UTC-consistentes (44% de falso-positivo) — fica com o irmão de SP.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { CHAMADA, classificar, JANELA, lerArgumentos, type Motivo } from './fuso-da-sessao-em-provas-gate';
import type { MigrationLida } from './lib/corpo-esperado';
import { modelarRepo } from './lib/deriva-corpo';
import { somenteCercas } from './lib/markdown-codigo';
import { maiorBlocoDescartadoSql, removerComentariosSql } from './lib/sql-comentarios';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

export const PISOS = {
  /** Migrations lidas — zero é leitura quebrada, nunca "repo sem DDL". Eram 740 em 2026-09-27. */
  migrations: 700,
  /** Arquivos de skill lidos (`.sql` + `.md`). Eram 46. */
  arquivosDeSkill: 40,
  /** Linhas de CÓDIGO de skill lidas (`.sql` + cercas). Eram 2.270: abrir arquivo não é ler consulta. */
  linhasDeCodigoDeSkill: 2000,
  /** Corpos vivos de função — o denominador do 3º universo. Eram 312. */
  corposVivos: 290,
} as const;

/**
 * Teto do maior bloco CONTÍGUO que o stripper descarta num arquivo. Acima dele, o stripper
 * provavelmente comeu código (literal ou dollar-quote mal fechado) e o gate mediria prosa. Medido em
 * 2026-09-27: migrations 175 — comentário de verdade, 175 linhas `--` seguidas no cabeçalho de
 * 20260615130000_tint_vigia_cobertura_sentinela.sql —; skills 20 (os cabeçalhos de cfo-colacor/assets/sql).
 */
export const TETO_BLOCO_DESCARTADO = { migrations: 200, skills: 40 } as const;

export interface Sitio {
  arquivo: string;
  linha: number;
  /** A chamada como o Postgres a leu, em minúscula e com espaço colapsado — a identidade na baseline. */
  trecho: string;
  motivo: Motivo;
}

export interface SitioConhecido {
  arquivo: string;
  trecho: string;
  /** Quantas vezes o trecho aparece no arquivo. Muda para MAIS = sítio novo; para MENOS = quitou. */
  n: number;
  motivo: string;
}

const SUPERA = 'superada por 20260927202603_fuso_sp_relogio_da_sessao_rpcs_views_des.sql';
export const CONHECIDOS: readonly SitioConhecido[] = [
  {
    arquivo: 'supabase/migrations/20260328200600_financeiro_v3_backend.sql',
    trecho: "date_trunc('week', current_date)", n: 1,
    motivo: `fin_projecao_13_semanas, definição de março — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260329161846_ef165ca0-5e29-4b16-8c40-9e14396fdc7b.sql',
    trecho: "date_trunc('week', current_date)", n: 1,
    motivo: `fin_projecao_13_semanas, recriada pelo builder — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260512101121_a96fa007-f688-4c3a-8cd9-43f9d88e5505.sql',
    trecho: "date_trunc('week', current_date)", n: 1,
    motivo: `fin_projecao_13_semanas, a que a prod rodava até 2026-09-27 — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260612130000_radar_rpcs_contato.sql',
    trecho: "date_trunc('month', now())", n: 1,
    motivo: `radar_kpis, a que a prod rodava até 2026-09-27 — ${SUPERA}`,
  },
];

const normalizar = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Os sítios num texto SQL. A limpeza de comentário é daqui; a numeração de linha é a do texto. */
export function detectarNoSql(arquivo: string, sqlCru: string): { sitios: Sitio[]; ilegiveis: string[] } {
  const limpo = removerComentariosSql(sqlCru);
  const sitios: Sitio[] = [];
  const ilegiveis: string[] = [];
  for (const m of limpo.matchAll(CHAMADA)) {
    const linha = limpo.slice(0, m.index).split('\n').length;
    const abre = m.index + m[0].length - 1;
    const args = lerArgumentos(limpo.slice(abre, abre + JANELA));
    if (args === null) {
      ilegiveis.push(`${arquivo}:${linha}: date_trunc( que não fecha em ${JANELA} caracteres — a chamada não foi lida`);
      continue;
    }
    const motivo = classificar(args);
    if (motivo) sitios.push({ arquivo, linha, trecho: normalizar(`date_trunc(${args.join(', ')})`), motivo });
  }
  return { sitios, ilegiveis };
}

export interface Arquivo {
  /** Caminho relativo à raiz, com `/` — é a chave da baseline. */
  caminho: string;
  fonte: string;
}

export interface Analise {
  /** Todos os arquivos lidos — em modo fixture, nenhum é migration nem skill pelo caminho. */
  arquivos: number;
  migrations: number;
  arquivosDeSkill: number;
  linhasDeCodigoDeSkill: number;
  corposVivos: number;
  violacoes: Sitio[];
  /** Por `arquivo · trecho`, quantas vezes cada casamento apareceu — o que se confronta com a baseline. */
  contagem: Map<string, number>;
  /** Corpos vivos com a classe: `nome(tipos) — trecho`. Não há baseline para eles. */
  corposVivosComSitio: string[];
  alarmes: string[];
  ilegiveis: string[];
}

const ehSkill = (c: string) => c.startsWith('.claude/skills/');

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
    arquivos: arquivos.length, migrations: 0, arquivosDeSkill: 0, linhasDeCodigoDeSkill: 0, corposVivos: corpos.size,
    violacoes: [], contagem: new Map(), corposVivosComSitio: [], alarmes: [], ilegiveis: [],
  };
  for (const a of arquivos) {
    const { codigo, alarme } = codigoDe(a);
    if (alarme) r.alarmes.push(alarme);
    const skill = ehSkill(a.caminho);
    if (skill) {
      r.arquivosDeSkill++;
      r.linhasDeCodigoDeSkill += codigo.split('\n').filter((l) => l.trim() !== '').length;
    } else if (a.caminho.startsWith('supabase/migrations/')) {
      r.migrations++;
    }
    const teto = skill || a.caminho.endsWith('.md') ? TETO_BLOCO_DESCARTADO.skills : TETO_BLOCO_DESCARTADO.migrations;
    const bloco = maiorBlocoDescartadoSql(codigo);
    if (bloco > teto) r.alarmes.push(`${a.caminho}: o stripper descartou ${bloco} linhas seguidas (teto ${teto}) — comeu código?`);
    const d = detectarNoSql(a.caminho, codigo);
    r.ilegiveis.push(...d.ilegiveis);
    for (const s of d.sitios) {
      r.violacoes.push(s);
      const k = `${s.arquivo} · ${s.trecho}`;
      r.contagem.set(k, (r.contagem.get(k) ?? 0) + 1);
    }
  }
  for (const [alvo, corpo] of corpos) {
    for (const s of detectarNoSql(alvo, corpo).sitios) r.corposVivosComSitio.push(`${alvo} — ${s.trecho} (${s.motivo})`);
  }
  return r;
}

/** Diferença entre o que a varredura achou e a baseline: o que é NOVO e o que foi QUITADO. */
export function confrontar(contagem: ReadonlyMap<string, number>, conhecidos: readonly SitioConhecido[]) {
  const esperado = new Map(conhecidos.map((c) => [`${c.arquivo} · ${c.trecho}`, c.n]));
  const novos: string[] = [];
  const quitados: string[] = [];
  for (const [k, n] of contagem) if ((esperado.get(k) ?? 0) < n) novos.push(`${k} (${n}× no texto, baseline ${esperado.get(k) ?? 0})`);
  for (const [k, n] of esperado) if ((contagem.get(k) ?? 0) < n) quitados.push(`${k} (baseline ${n}, texto ${contagem.get(k) ?? 0})`);
  return { novos, quitados };
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = [...r.alarmes.map((a) => `stripper — ${a}`), ...r.ilegiveis.map((x) => `chamada ilegível — ${x}`)];
  if (r.arquivos === 0) furos.push('nenhum arquivo lido');
  if (comPisos) {
    if (r.migrations < PISOS.migrations) furos.push(`${r.migrations} migration(s) lida(s) < piso ${PISOS.migrations}`);
    if (r.arquivosDeSkill < PISOS.arquivosDeSkill) furos.push(`${r.arquivosDeSkill} arquivo(s) de skill < piso ${PISOS.arquivosDeSkill}`);
    if (r.linhasDeCodigoDeSkill < PISOS.linhasDeCodigoDeSkill) {
      furos.push(`${r.linhasDeCodigoDeSkill} linha(s) de código de skill < piso ${PISOS.linhasDeCodigoDeSkill} — abriu arquivo, mas não leu consulta?`);
    }
    if (r.corposVivos < PISOS.corposVivos) furos.push(`${r.corposVivos} corpo(s) vivo(s) < piso ${PISOS.corposVivos}`);
  }
  if (furos.length > 0) {
    return { codigo: 2, linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)] };
  }
  // Com baseline, só o que ela não conhece reprova; sem ela (fixture), todo sítio reprova.
  const { novos, quitados } = comPisos ? confrontar(r.contagem, CONHECIDOS) : { novos: r.violacoes.map((s) => `${s.arquivo}:${s.linha} ${s.trecho}`), quitados: [] };
  if (novos.length + quitados.length + r.corposVivosComSitio.length > 0) {
    const onde = (s: string) => r.violacoes.filter((v) => s.startsWith(`${v.arquivo} · ${v.trecho}`)).map((v) => `${v.arquivo}:${v.linha} (${v.motivo})`);
    return {
      codigo: 1,
      linhas: [
        '❌ date_trunc de calendário sobre o relógio da SESSÃO, sem o fuso escrito:',
        ...novos.map((n) => `  NOVO ${n}${comPisos ? `\n      ${onde(n).join('\n      ')}` : ''}`),
        ...quitados.map((q) => `  QUITADO (tire da baseline CONHECIDOS) ${q}`),
        ...r.corposVivosComSitio.map((c) => `  CORPO VIVO ${c}`),
        '',
        '  A prod roda sessão UTC: das 21:00 às 23:59 BRT o dia/semana/mês/trimestre da sessão já é o seguinte.',
        "  Conserto: o fuso NA EXPRESSÃO — date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') para",
        "  data de SP; date_trunc('month', now(), 'America/Sao_Paulo') para o instante (comparar com timestamptz).",
        '  O relógio LOCAL (current_date, localtimestamp, now()::date) não tem conserto no lugar: parta de now().',
        "  UTC de propósito se escreve: now() AT TIME ZONE 'UTC'.",
        '  docs/historico/relogio-da-sessao-truncado-rpcs-e-views-des.md',
      ],
    };
  }
  const censo = comPisos
    ? ` (${r.migrations} migrations, ${r.arquivosDeSkill} arquivos de skill com ${r.linhasDeCodigoDeSkill} linhas de código, ${r.corposVivos} corpos vivos; ${CONHECIDOS.length} definições mortas conhecidas)`
    : ` (${r.arquivos} arquivo(s))`;
  return { codigo: 0, linhas: [`✅ fuso da sessão em migrations e skills${censo}: nenhum date_trunc de calendário sobre o relógio da sessão sem fuso.`] };
}

function andar(dir: string, ok: (p: string) => boolean, acc: string[] = []): string[] {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) andar(p, ok, acc);
    else if (ok(p)) acc.push(p);
  }
  return acc;
}

const ler = (base: string, p: string): Arquivo => ({ caminho: relative(base, p).split('\\').join('/'), fonte: readFileSync(p, 'utf8') });

/** A última definição viva de cada função que as migrations dão (o modelo "a última a recriar vence"). */
export function corposVivosDe(arquivos: readonly Arquivo[]): Map<string, string> {
  const lidas: MigrationLida[] = arquivos
    .filter((a) => a.caminho.startsWith('supabase/migrations/'))
    .map((a) => ({ nome: a.caminho.split('/').pop() ?? a.caminho, sql: a.fonte }));
  const corpos = new Map<string, string>();
  for (const [alvo, estado] of modelarRepo(lidas).identidades) {
    const ultima = estado.versoes[estado.versoes.length - 1];
    if (!estado.aposentadaPor && ultima?.corpo) corpos.set(alvo, ultima.corpo);
  }
  return corpos;
}

/** O repo inteiro: as migrations, as skills e os corpos vivos que as migrations definem. */
export function lerRepo(raiz: string): { arquivos: Arquivo[]; corpos: Map<string, string> } {
  const migrations = andar(join(raiz, 'supabase', 'migrations'), (p) => p.endsWith('.sql')).map((p) => ler(raiz, p));
  const skills = andar(join(raiz, '.claude', 'skills'), (p) => /\.(sql|md)$/.test(p)).map((p) => ler(raiz, p));
  return { arquivos: [...migrations, ...skills], corpos: corposVivosDe(migrations) };
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    const { arquivos, corpos } = lerRepo(raizDoRepo());
    const { codigo, linhas } = veredito(analisar(arquivos, corpos), true);
    (codigo === 0 ? console.log : console.error)(linhas.join('\n'));
    return codigo;
  }
  const base = process.cwd();
  const arquivos = argv.flatMap((d) => andar(resolve(base, d), (p) => /\.(sql|md)$/.test(p))).map((p) => ler(base, p));
  const { codigo, linhas } = veredito(analisar(arquivos), false);
  (codigo === 0 ? console.log : console.error)(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
