// Gate da classe "data de SP medida no fuso da SESSÃO" — docs/historico/positivacao-mes-sp-sob-sessao-utc.md
//
// A prod roda sessões em UTC (TimeZone=UTC do arquivo de configuração, sem override por papel ou
// banco; o PostgREST herda). Uma função que raciocina em São Paulo e, no meio do corpo, deixa o
// Postgres converter por conta própria mede no fuso da SESSÃO: das 21:00 às 23:59 BRT o "dia" já é
// o seguinte. Instância-mãe: `_carteira_positivacao_for_owner` (20260525210000) fixava o mês em SP
// e comparava `farmer_calls.started_at` (timestamptz) contra essas datas — corrigida pela
// 20260927133606, que converte a COLUNA para a data de SP antes de comparar.
//
// Três formas, todas só em corpo que menciona `AT TIME ZONE 'America/Sao_Paulo'` (é o sinal de que
// a semântica é SP; função sem ele pode ser UTC de propósito e está fora deste gate):
//   A · coluna `*_at`/`*_em` comparada com variável `date`/`timestamp` calculada em SP — o cast
//       implícito da comparação usa o fuso da sessão;
//   B · coluna `*_at`/`*_em` convertida pelo fuso da sessão: `::date`, `::timestamp`, `CAST`, `date()`,
//       `date_trunc('dia|mês|…', col)`, `extract(hora|dia|… from col)`;
//   C · o "hoje/agora" da sessão misturado num corpo SP: `current_date`, `now()::date`,
//       `localtimestamp`, `date_trunc('dia|mês|…', now())`.
//
// Só a ÚLTIMA definição viva de cada função conta (`modelarRepo`, o mesmo modelo "a última a
// recriar vence" do sensor de deriva) — as migrations antigas são imutáveis, e o que importa é o
// corpo que vale hoje. Comentário sai pelo stripper COMPARTILHADO (`removerComentariosSql`).
//
// LIMITES DECLARADOS (o gate não os pega; a prova executada é quem pega):
//   · timestamptz fora da convenção `*_at`/`*_em` — 50 de 658 colunas na prod (2026-09-27);
//   · comparação com a coluna entre parênteses ou via expressão (`(fc.started_at) >= v`);
//   · função que não menciona `America/Sao_Paulo` (fuso implícito do caller) — as famílias A/B/C nela
//     dariam 44% de falso-positivo (15 de 34 sítios UTC-consistentes, medido em 2026-09-27); o
//     `date_trunc` de calendário sobre o relógio da sessão, esse, é medido em TODO corpo vivo (e em
//     view, cron e skill) por `fuso-da-sessao-em-migrations-e-skills-gate.ts`;
//   · SQL dinâmico montado em string (`EXECUTE format(...)`).
import { modelarRepoPassos, type ModeloDoRepo } from './lib/deriva-corpo';
import { drenar, type Passos } from '@/lib/gates/passos';
import type { MigrationLida } from './lib/corpo-esperado';
import { removerComentariosSql } from './lib/sql-comentarios';

export type Familia = 'A' | 'B' | 'C';

export interface Achado {
  familia: Familia;
  /** O trecho casado, em minúscula e com espaço colapsado — é a identidade do sítio na baseline. */
  trecho: string;
}

const SP = /AT\s+TIME\s+ZONE\s+'America\/Sao_Paulo'/i;
const OP = String.raw`(?:>=|<=|<>|!=|=|<|>)`;
// Coluna timestamptz pela CONVENÇÃO de nome: `*_at` ou `*_em`. Medido na prod em 2026-09-27: das 658
// colunas timestamptz de tabelas de `public`, 432 terminam em `_at` e 176 em `_em` (92,4% juntas);
// nenhuma `*_at` tem outro tipo, e as `*_em` que não são timestamptz são 3 nomes `date` — excluídos
// abaixo. As 50 restantes (`data_evento`, `ultima_sincronizacao`, `window_start`…) são ponto cego.
const COL_AT = String.raw`(?:[a-z_][a-z0-9_]*\.)?(?!(?:inicio_em|medido_em|suspensa_em)\b)[a-z_][a-z0-9_]*_(?:at|em)`;
/** Não pode vir colado a identificador, ponto ou `::` — senão `x.y_at` casaria só o `y_at`. */
const ANTES = String.raw`(?<![a-z0-9_$.:])`;

const normalizar = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Variáveis `date`/`timestamp` (sem fuso) cujo valor sai de uma expressão em SP. */
function variaveisEmSp(codigo: string): string[] {
  const declaradas = new Set<string>();
  const tipo = /\b([a-z_][a-z0-9_]*)\s+(?:date|timestamp(?:\s+without\s+time\s+zone)?)\s*(?=;|:=|=|\bdefault\b)/gi;
  for (const m of codigo.matchAll(tipo)) declaradas.add(m[1].toLowerCase());
  const emSp = new Set<string>();
  const marcar = (nome: string, expr: string) => {
    if (declaradas.has(nome.toLowerCase()) && SP.test(expr)) emSp.add(nome.toLowerCase());
  };
  // inicializador na declaração OU atribuição posterior — `:=`, `=` (o PL/pgSQL aceita os dois) ou
  // DEFAULT —, com o lado direito até o `;`. `>=`/`<=`/`!=` não casam: o `=` delas não vem colado a
  // identificador. Uma comparação `d = <expr SP>` casa e marca `d` — excesso inofensivo.
  const atrib = /\b([a-z_][a-z0-9_]*)\s*(?:date|timestamp(?:\s+without\s+time\s+zone)?)?\s*(?::=|=|\bdefault\b)\s*([^;]*);/gi;
  for (const m of codigo.matchAll(atrib)) marcar(m[1], m[2]);
  // a outra forma de atribuir em PL/pgSQL: `SELECT <expr> INTO [STRICT] var`
  const into = /\bselect\s+([^;]*?)\s+into\s+(?:strict\s+)?([a-z_][a-z0-9_]*)\b/gi;
  for (const m of codigo.matchAll(into)) marcar(m[2], m[1]);
  return [...emSp];
}

/** Os sítios da classe num corpo de função. Corpo sem `America/Sao_Paulo` não é medido. */
export function detectarFusoDaSessao(corpoCru: string): Achado[] {
  const codigo = removerComentariosSql(corpoCru);
  if (!SP.test(codigo)) return [];
  const achados: Achado[] = [];
  const casar = (familia: Familia, re: RegExp) => {
    for (const m of codigo.matchAll(re)) achados.push({ familia, trecho: normalizar(m[0]) });
  };

  for (const v of variaveisEmSp(codigo)) {
    // A variável convertida para INSTANTE de SP (`d::timestamp AT TIME ZONE 'America/Sao_Paulo'`) é o
    // conserto pela borda — a forma que usa índice —, não sítio. Só essa forma: `d::timestamptz`
    // ainda casta no fuso da sessão e segue acusado.
    const vCru = String.raw`${v}\b(?!\s*::\s*timestamp(?:\s+without\s+time\s+zone)?\s+AT\s+TIME\s+ZONE\s+'America\/Sao_Paulo')`;
    // coluna OP var  ·  var OP coluna (e a coluna não pode ser o lado esquerdo de um AT TIME ZONE)
    casar('A', new RegExp(String.raw`${ANTES}${COL_AT}\s*${OP}\s*${vCru}`, 'gi'));
    casar('A', new RegExp(String.raw`${ANTES}${v}\s*${OP}\s*${COL_AT}\b(?!\s*AT\s+TIME\s+ZONE)`, 'gi'));
    casar('A', new RegExp(String.raw`${ANTES}${COL_AT}\s+BETWEEN\s+(?:${vCru}|[^;]{1,80}?\bAND\s+${vCru})`, 'gi'));
  }

  casar('B', new RegExp(String.raw`${ANTES}${COL_AT}\s*::\s*(?:date|timestamp)\b(?!\s*with\b)`, 'gi'));
  casar('B', new RegExp(String.raw`\bdate\s*\(\s*${COL_AT}\s*\)`, 'gi'));
  casar('B', new RegExp(String.raw`\bcast\s*\(\s*${COL_AT}\s+as\s+(?:date|timestamp(?:\s+without\s+time\s+zone)?)\s*\)`, 'gi'));
  casar('B', new RegExp(String.raw`\bdate_trunc\s*\(\s*'(?:day|week|month|quarter|year)'\s*,\s*${COL_AT}\s*\)`, 'gi'));
  casar('B', new RegExp(String.raw`\bextract\s*\(\s*(?:hour|day|dow|isodow|doy|week|month|quarter|year)\s+from\s+${COL_AT}\s*\)`, 'gi'));

  casar('C', /\bcurrent_date\b/gi);
  casar('C', /\bnow\s*\(\s*\)\s*::\s*date\b/gi);
  casar('C', /\blocaltimestamp\b/gi);
  casar('C', /\bdate_trunc\s*\(\s*'(?:day|week|month|quarter|year)'\s*,\s*(?:now\s*\(\s*\)|current_timestamp|clock_timestamp\s*\(\s*\))\s*\)/gi);
  return achados;
}

export type Veredito = 'divida' | 'falso-positivo';

export interface SitioConhecido {
  /** `nome(tipos)` — a chave de identidade do `modelarRepo`. */
  alvo: string;
  familia: Familia;
  trecho: string;
  /** Quantas vezes o trecho aparece no corpo vivo. Muda para MAIS = sítio novo; para MENOS = quitou. */
  n: number;
  veredito: Veredito;
  motivo: string;
}

// Os sítios que a varredura de 2026-09-27 achou nas definições VIVAS, cada um com veredito lido no
// corpo e medido em prod. A lista só ENCOLHE: sítio novo reprova; entrada quitada que fica reprova.
// (A instância-mãe, `_carteira_positivacao_for_owner`, não está aqui: a 20260927133606 a quitou. As 2
// dívidas da família C — `get_ultimos_precos_cliente(uuid)` e `medir_abaixo_piso_tier(integer)`, com
// `current_date` num corpo SP — saíram com a 20260927172443, que usa o hoje de SP pelo instante.)
export const CONHECIDOS: readonly SitioConhecido[] = [];

export const PISOS = {
  /** Migrations lidas — zero é leitura quebrada, nunca "repo sem DDL". Eram 739 em 2026-09-27. */
  migrations: 700,
  /** Identidades vivas cujo corpo raciocina em SP — o denominador do que o gate mede. Eram 17. */
  identidadesComSp: 15,
  /**
   * Teto do maior bloco CONTÍGUO que o stripper descarta num corpo medido. Acima dele, o stripper
   * provavelmente comeu código (literal ou dollar-quote mal fechado) e o gate mediria prosa. Medido
   * em 2026-09-27: 54, e é comentário de verdade (o cabeçalho `analytics_outbox_trigger` no corpo de
   * `_data_health_compute`, linha 893 da 20260922225500); o 2º maior é 6.
   */
  blocoDescartado: 60,
} as const;

export interface Varredura {
  /** O modelo que a varredura construiu — quem precisa dele reaproveita em vez de remodelar 740 arquivos. */
  modelo: ModeloDoRepo;
  migrations: number;
  identidadesVivas: number;
  identidadesComSp: string[];
  /** Por alvo, os achados na ÚLTIMA definição viva. */
  achados: Map<string, Achado[]>;
}

export function varrerMigrations(migrations: readonly MigrationLida[]): Varredura {
  return drenar(varrerMigrationsPassos(migrations));
}

/** A varredura como gerador (`@/lib/gates/passos`): cede uma vez por migration (o fold) e uma por
 *  identidade (o detector sobre o corpo vivo, ~3× o custo do fold) — o teste drena cedendo o event
 *  loop do worker do vitest. */
export function* varrerMigrationsPassos(migrations: readonly MigrationLida[]): Passos<Varredura> {
  const modelo = yield* modelarRepoPassos(migrations);
  const achados = new Map<string, Achado[]>();
  const identidadesComSp: string[] = [];
  let vivas = 0;
  for (const [alvo, estado] of modelo.identidades) {
    yield; // no TOPO: as saídas por `continue` também cedem
    if (estado.aposentadaPor) continue;
    const ultima = estado.versoes[estado.versoes.length - 1];
    if (!ultima?.corpo) continue;
    vivas++;
    if (!SP.test(removerComentariosSql(ultima.corpo))) continue;
    identidadesComSp.push(alvo);
    const a = detectarFusoDaSessao(ultima.corpo);
    if (a.length) achados.set(alvo, a);
  }
  return { modelo, migrations: modelo.migrations, identidadesVivas: vivas, identidadesComSp, achados };
}

const chave = (alvo: string, familia: Familia, trecho: string) => `${alvo} · ${familia} · ${trecho}`;

/** Diferença entre o que a varredura achou e a baseline: o que é NOVO e o que foi QUITADO. */
export function confrontar(v: Varredura, conhecidos: readonly SitioConhecido[]) {
  const achado = new Map<string, number>();
  for (const [alvo, lista] of v.achados) {
    for (const a of lista) achado.set(chave(alvo, a.familia, a.trecho), (achado.get(chave(alvo, a.familia, a.trecho)) ?? 0) + 1);
  }
  const esperado = new Map(conhecidos.map((c) => [chave(c.alvo, c.familia, c.trecho), c.n]));
  const novos: string[] = [];
  const quitados: string[] = [];
  for (const [k, n] of achado) if ((esperado.get(k) ?? 0) < n) novos.push(`${k} (${n}× no corpo vivo, baseline ${esperado.get(k) ?? 0})`);
  for (const [k, n] of esperado) if ((achado.get(k) ?? 0) < n) quitados.push(`${k} (baseline ${n}, corpo vivo ${achado.get(k) ?? 0})`);
  return { novos, quitados };
}
