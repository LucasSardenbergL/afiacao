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
//   B · coluna `*_at`/`*_em` convertida pelo fuso da sessão: `::date`, `::timestamp`, `date(...)`,
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
//   · função que não menciona `America/Sao_Paulo` (fuso implícito do caller);
//   · SQL dinâmico montado em string (`EXECUTE format(...)`).
import { modelarRepo } from './lib/deriva-corpo';
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
  // inicializador na declaração OU atribuição posterior — em ambos, o lado direito até o `;`
  const atrib = /\b([a-z_][a-z0-9_]*)\s*(?:date|timestamp(?:\s+without\s+time\s+zone)?)?\s*(?::=|\bdefault\b)\s*([^;]*);/gi;
  for (const m of codigo.matchAll(atrib)) {
    const nome = m[1].toLowerCase();
    if (declaradas.has(nome) && SP.test(m[2])) emSp.add(nome);
  }
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
    // coluna OP var  ·  var OP coluna (e a coluna não pode ser o lado esquerdo de um AT TIME ZONE)
    casar('A', new RegExp(String.raw`${ANTES}${COL_AT}\s*${OP}\s*${v}\b`, 'gi'));
    casar('A', new RegExp(String.raw`${ANTES}${v}\s*${OP}\s*${COL_AT}\b(?!\s*AT\s+TIME\s+ZONE)`, 'gi'));
    casar('A', new RegExp(String.raw`${ANTES}${COL_AT}\s+BETWEEN\s+(?:${v}\b|[^;]{1,80}?\bAND\s+${v}\b)`, 'gi'));
  }

  casar('B', new RegExp(String.raw`${ANTES}${COL_AT}\s*::\s*(?:date|timestamp)\b(?!\s*with\b)`, 'gi'));
  casar('B', new RegExp(String.raw`\bdate\s*\(\s*${COL_AT}\s*\)`, 'gi'));
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
// (A instância-mãe, `_carteira_positivacao_for_owner`, não está aqui: a 20260927133606 a quitou.)
export const CONHECIDOS: readonly SitioConhecido[] = [
  {
    alvo: 'get_ultimos_precos_cliente(uuid)', familia: 'C', trecho: 'current_date', n: 1, veredito: 'divida',
    motivo: 'filtro anti-futuro `data de SP <= current_date`: das 21:00 às 23:59 BRT o "hoje" da sessão já é '
      + 'amanhã em SP e o filtro aceita pedido datado de amanhã. Efeito medido em 2026-09-27: 0 pedidos com '
      + 'kpi depois de hoje-SP. Chip "Corrigir current_date UTC em 2 funções de data SP".',
  },
  {
    alvo: 'medir_abaixo_piso_tier(integer)', familia: 'C', trecho: 'current_date', n: 1, veredito: 'divida',
    motivo: 'janela `data de SP >= current_date - p_dias`: das 21:00 às 23:59 BRT perde o dia mais antigo. '
      + 'É medição de auditoria (algorithm-a-audit), não decisão de dinheiro. Mesmo chip.',
  },
  {
    alvo: '_data_health_compute()', familia: 'C', trecho: 'current_date', n: 2, veredito: 'falso-positivo',
    motivo: 'compara com `pedido_compra_sugerido.data_ciclo`, que a edge gerar-pedidos-diario grava como data '
      + 'UTC (`new Date().toISOString().slice(0, 10)`): UTC contra UTC é consistente. O SP do corpo é de '
      + 'outros checks. Ressalva não medida: o override `body.data_ciclo` da edge aceita data do caller.',
  },
];

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
  migrations: number;
  identidadesVivas: number;
  identidadesComSp: string[];
  /** Por alvo, os achados na ÚLTIMA definição viva. */
  achados: Map<string, Achado[]>;
}

export function varrerMigrations(migrations: readonly MigrationLida[]): Varredura {
  const modelo = modelarRepo(migrations);
  const achados = new Map<string, Achado[]>();
  const identidadesComSp: string[] = [];
  let vivas = 0;
  for (const [alvo, estado] of modelo.identidades) {
    if (estado.aposentadaPor) continue;
    const ultima = estado.versoes[estado.versoes.length - 1];
    if (!ultima?.corpo) continue;
    vivas++;
    if (!SP.test(removerComentariosSql(ultima.corpo))) continue;
    identidadesComSp.push(alvo);
    const a = detectarFusoDaSessao(ultima.corpo);
    if (a.length) achados.set(alvo, a);
  }
  return { migrations: modelo.migrations, identidadesVivas: vivas, identidadesComSp, achados };
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
