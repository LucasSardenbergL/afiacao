/**
 * transporte-nuvem.ts — a MESMA leitura read-only de prod que o `psql-ro` faz, por um transporte que
 * existe na NUVEM: a ferramenta `query_database` do conector Lovable.
 *
 * POR QUE EXISTE (2026-09-27). A sessão da nuvem não tem o `psql-ro` — a credencial é local e não
 * deve sair do Mac (database.md §1, ci.yml) — nem rede até o Supabase (o proxy nega). Sem braço, o
 * `/fecho` de toda sessão na nuvem terminava num chip "Conferir prod" para uma sessão LOCAL, e o
 * gargalo virava o Mac do founder. O conector Lovable (OAuth no claude.ai, sem segredo em repo nem
 * em runner) dá à nuvem o MESMO canal que a sessão local já usa para o envelope de escrita. Faltava
 * a ponte até os CLIs determinísticos: eles chamam `psql`, e só o MODELO chama ferramenta MCP.
 *
 * O CONTRATO — o modelo vira TRANSPORTADOR, nunca fonte:
 *   1. o CLI com `--sql-nuvem` imprime UM SQL (`SET TRANSACTION READ ONLY; … SELECT json`);
 *   2. o modelo roda esse texto VERBATIM pelo `query_database` e grava a resposta num arquivo;
 *   3. o CLI com `--dados-nuvem=<arquivo>` valida e devolve, por consulta, as MESMAS linhas que o
 *      `psql -A -F '|' -t` daria — e o juízo segue o caminho de sempre, sem saber de onde veio.
 *
 * As provas, todas medidas PELO BANCO e amarradas no md5 do payload (o modelo não calcula md5 de
 * cabeça, então nenhuma delas se falsifica sem quebrar a conta):
 *   - `somente_leitura = on` — o `SET TRANSACTION` pegou na MESMA transação do SELECT. O
 *     `query_database` entra como `postgres`, com BYPASSRLS e sem modo leitura (piloto, Camada 3);
 *     o lote multi-statement é UMA transação implícita (medido lá), então o prefixo trava escrita no
 *     lote inteiro. Se um dia o transporte mandar os statements separados, o SET vira no-op com
 *     WARNING e o SELECT diz `off` — e a leitura é RECUSADA, não aceita com a trava fora.
 *   - `teto = 30s` — o `statement_timeout` do wrapper local, reposto por `SET LOCAL`.
 *   - `sql_md5` — md5 do trecho entre as marcas, lido de `current_query()`: o texto que o banco
 *     EXECUTOU é byte a byte o que o CLI emitiu. Um SQL "corrigido" no caminho não passa.
 *   - `medido_em` — relógio do banco. Resposta de outra rodada, reaproveitada, não é medição desta.
 *
 * FIDELIDADE ao psql, para QUALQUER tipo: cada linha viaja como o literal de registro do próprio
 * Postgres (`q::text`, o `record_out`), que monta cada campo com a MESMA função de saída do tipo que
 * o psql imprime — boolean sai `t`, timestamp sai com espaço, array sai `{…}`. O TS desfaz só o
 * envelope do registro (parênteses, vírgulas, aspas) e junta os campos com `|`, como o
 * `psql -A -F '|' -t`. Uma tentativa com `row_to_json` foi descartada: ela fala o dialeto do JSON
 * (`true`, `T`, `[…]`) e só coincidia com o psql em text/numeric. A prova de equivalência contra
 * um Postgres de verdade é `db/test-transporte-nuvem.sh`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const FORMATO_TRANSPORTE = 'transporte-nuvem/1';

/** O `statement_timeout` do `psqlrc-ro` local — a nuvem não ganha teto mais frouxo que o Mac. */
export const TETO_TRANSPORTE = '30s';

/** Resposta mais velha que isto não é medição DESTA rodada (o coletor do ledger tolera 45 min). */
export const IDADE_MAXIMA_MIN = 30;

/** Relógio do banco à frente do local além disto é dado que não se explica — recusa. */
export const FOLGA_RELOGIO_MIN = 5;

const MARCA_INICIO = 'sql-nuvem:inicio';
const MARCA_FIM = 'sql-nuvem:fim';
const PREFIXO_MARCA = 'sql-nuvem';

/** `json_build_object`/`concat_ws` param 100 argumentos no máximo; 30 consultas cabem com folga. */
const MAX_CONSULTAS = 30;
const NOME_CONSULTA = /^[a-z][a-z0-9_]{0,40}$/;
const NOME_CONSUMIDOR = /^[a-z][a-z0-9-]{0,60}$/;

/** Nome curto → SQL de UMA consulta, exatamente como o CLI a passaria ao `psql -c`. */
export type Consultas = Readonly<Record<string, string>>;

export interface DadosNuvem {
  /** O `now()` do banco na transação da leitura — a idade de cada linha é relativa a ele. */
  medidoEm: Date;
  /** Por NOME de consulta: as linhas unidas por `\n`, na forma que o `psql -A -F '|' -t` imprime
   *  (o payload traz o literal de registro; a conversão é `registroParaLinha`). */
  saidas: ReadonlyMap<string, string>;
  /** As mesmas linhas, uma por registro — preserva "1 linha vazia" ≠ "0 linhas", que `saidas` funde. */
  linhas: ReadonlyMap<string, readonly string[]>;
}

function md5(texto: string): string {
  return createHash('md5').update(texto, 'utf8').digest('hex');
}

/**
 * Uma consulta vira UMA linha, sem `;` final — ela entra como subconsulta de um único statement.
 *
 * Recusa (em vez de "consertar") tudo que tornaria a junção de linhas capaz de mudar o SQL: `;` no
 * meio, comentário de linha (engoliria o resto), dollar-quoting e `\'` (o fim do literal deixa de
 * ser contável) e literal que atravessa quebra de linha (a junção reescreveria o texto dele).
 * Recusar aqui é falhar na MÁQUINA de quem escreveu a consulta, não em prod.
 */
function umaLinha(nome: string, sql: string): string {
  const recusa = (motivo: string) =>
    new Error(`TRANSPORTE_CONSULTA_INVALIDA: a consulta '${nome}' ${motivo}`);
  let corpo = sql.trim();
  if (corpo.endsWith(';')) corpo = corpo.slice(0, -1).trimEnd();
  if (corpo === '') throw recusa('veio vazia');
  if (corpo.includes(';')) throw recusa("tem ';' no meio — o transporte embute cada consulta num statement só");
  if (corpo.includes('--')) throw recusa("tem '--' — numa linha só, o comentário engoliria o resto do SQL");
  if (/\$[A-Za-z_]*\$/.test(corpo)) throw recusa('usa dollar-quoting — o fim do literal deixa de ser contável');
  if (corpo.includes("\\'")) throw recusa("tem \\' — o fim do literal deixa de ser contável");
  if (corpo.includes(PREFIXO_MARCA)) throw recusa(`contém '${PREFIXO_MARCA}', a marca do transporte`);

  const linhas = corpo.split('\n');
  let aspas = 0;
  for (let i = 0; i < linhas.length - 1; i += 1) {
    aspas += (linhas[i].match(/'/g) ?? []).length;
    if (aspas % 2 !== 0) {
      throw recusa(`tem literal atravessando a quebra da linha ${i + 1} — juntar as linhas mudaria o texto dele`);
    }
  }
  const junta = linhas
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ');
  // ASCII imprimível + o plano básico sem controles C1 nem surrogates: `position`/`substring` do
  // Postgres contam CARACTERE e o `slice` do JS conta unidade UTF-16 — só no BMP as duas batem.
  if (/[^\x20-\x7e -퟿-￿]/.test(junta)) {
    throw recusa('tem caractere de controle ou fora do plano básico do Unicode');
  }
  return junta;
}

function validarNomes(consultas: Consultas, consumidor: string): string[] {
  if (!NOME_CONSUMIDOR.test(consumidor)) {
    throw new Error(`TRANSPORTE_CONSULTA_INVALIDA: consumidor fora do formato: ${JSON.stringify(consumidor)}`);
  }
  const nomes = Object.keys(consultas).sort();
  if (nomes.length === 0 || nomes.length > MAX_CONSULTAS) {
    throw new Error(`TRANSPORTE_CONSULTA_INVALIDA: ${nomes.length} consulta(s) — o pacote aceita de 1 a ${MAX_CONSULTAS}`);
  }
  const ruins = nomes.filter((n) => !NOME_CONSULTA.test(n));
  if (ruins.length > 0) {
    throw new Error(`TRANSPORTE_CONSULTA_INVALIDA: nome(s) de consulta fora do formato: ${ruins.join(', ')}`);
  }
  return nomes;
}

/** A posição da marca, sem que o texto contíguo dela apareça na própria expressão de busca. */
function posicao(marca: string): string {
  return `position('${PREFIXO_MARCA}' || '${marca.slice(PREFIXO_MARCA.length)}' IN current_query())`;
}

/**
 * O SQL que o modelo roda pelo `query_database`. Determinístico: mesmas consultas → mesmo texto
 * (é o que deixa o `--dados-nuvem` refazê-lo e conferir o `sql_md5`).
 */
export function gerarSqlNuvem(consultas: Consultas, consumidor: string): string {
  const nomes = validarNomes(consultas, consumidor);
  const corpos = nomes.map((n) => umaLinha(n, consultas[n]));
  const pi = posicao(MARCA_INICIO);
  const pf = posicao(MARCA_FIM);

  const colunas = nomes.map(
    (n, i) =>
      `(SELECT coalesce(array_agg(z.l), ARRAY[]::text[]) FROM ` +
      `(SELECT q::text AS l FROM (${corpos[i]}) AS q) AS z) AS c_${n}`,
  );
  const canonico = [
    `'${FORMATO_TRANSPORTE}'`,
    `'${consumidor}'`,
    'm.medido_em',
    'm.somente_leitura',
    'm.teto',
    'm.sql_md5',
    ...nomes.flatMap((n) => [`'${n}'`, `cardinality(c.c_${n})::text`, `array_to_string(c.c_${n}, E'\\n')`]),
  ];
  const objeto = nomes.map((n) => `'${n}', to_json(c.c_${n})`).join(', ');

  return [
    'SET TRANSACTION READ ONLY;',
    `SET LOCAL statement_timeout = '${TETO_TRANSPORTE}';`,
    `WITH marca AS (SELECT '${MARCA_INICIO}'::text AS inicio),`,
    `m AS (SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS medido_em,`,
    `current_setting('transaction_read_only') AS somente_leitura,`,
    `current_setting('statement_timeout') AS teto,`,
    `md5(substring(current_query() FROM ${pi} FOR ${pf} + ${MARCA_FIM.length} - ${pi})) AS sql_md5),`,
    `c AS (SELECT ${colunas.join(', ')})`,
    `SELECT json_build_object('formato', '${FORMATO_TRANSPORTE}', 'consumidor', '${consumidor}',`,
    `'medido_em', m.medido_em, 'somente_leitura', m.somente_leitura, 'teto', m.teto, 'sql_md5', m.sql_md5,`,
    `'consultas', json_build_object(${objeto}),`,
    `'md5', md5(concat_ws(E'\\n', ${canonico.join(', ')}))) AS dados_nuvem`,
    `FROM marca, m, c, (SELECT '${MARCA_FIM}'::text AS fim) AS marca_fim;`,
  ].join(' ');
}

/** O trecho que o `sql_md5` cobre — a mesma conta que o banco faz sobre `current_query()`. */
export function trechoMarcado(sql: string): string {
  const i = sql.indexOf(MARCA_INICIO);
  const f = sql.indexOf(MARCA_FIM);
  if (i < 0 || f < i) throw new Error('TRANSPORTE_SQL_DIVERGENTE: o SQL não tem as marcas do transporte');
  return sql.slice(i, f + MARCA_FIM.length);
}

/**
 * Tira o payload das embalagens em que ele pode chegar: o objeto puro (o que o procedimento pede),
 * a resposta inteira do `query_database` (`{"rows":[{"dados_nuvem":…}]}`), o valor como string
 * JSON, ou os blocos de conteúdo de um resultado de ferramenta salvo em disco. Ser tolerante AQUI
 * não afrouxa nada: o que decide é o md5, logo abaixo.
 */
function desembrulhar(valor: unknown, profundidade = 0): Record<string, unknown> {
  const falha = () =>
    new Error(
      'TRANSPORTE_FORMATO: não achei o objeto do transporte no arquivo — grave o valor da coluna ' +
        '`dados_nuvem` (o JSON que começa com {"formato":"transporte-nuvem/1"…) ou a resposta inteira do query_database',
    );
  if (profundidade > 5) throw falha();
  if (typeof valor === 'string') {
    try {
      return desembrulhar(JSON.parse(valor), profundidade + 1);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('TRANSPORTE_')) throw e;
      throw falha();
    }
  }
  if (Array.isArray(valor)) {
    if (valor.length > 0 && valor.every((b) => b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string')) {
      return desembrulhar(valor.map((b) => (b as { text: string }).text).join(''), profundidade + 1);
    }
    if (valor.length === 1) return desembrulhar(valor[0], profundidade + 1);
    throw falha();
  }
  if (valor !== null && typeof valor === 'object') {
    const obj = valor as Record<string, unknown>;
    if ('formato' in obj) return obj;
    if ('dados_nuvem' in obj) return desembrulhar(obj.dados_nuvem, profundidade + 1);
    if (Array.isArray(obj.rows)) {
      if (obj.rows.length !== 1) {
        throw new Error(`TRANSPORTE_FORMATO: a resposta trouxe ${obj.rows.length} linha(s); o SQL do transporte devolve exatamente 1`);
      }
      return desembrulhar(obj.rows[0], profundidade + 1);
    }
  }
  throw falha();
}

/**
 * Um literal de registro (`record_out`) → a linha que o `psql -A -F '|' -t` imprimiria.
 *
 * O `record_out` põe o campo entre aspas quando ele é vazio ou tem `"`, `\`, `(`, `)`, `,` ou
 * espaço, e dentro das aspas dobra `"` e `\`. Campo vazio SEM aspas é NULL. O psql imprime NULL e
 * texto vazio do mesmo jeito (`''`, sem `\pset null` — o `psqlrc-ro` não o define), então os dois
 * viram `''` aqui. A leitura segue a gramática do `record_in` (`\x` e `""` dentro das aspas), que
 * é um superconjunto do que o `record_out` emite. Literal fora da gramática LANÇA.
 */
export function registroParaLinha(registro: string): string {
  const ilegivel = () => new Error(`TRANSPORTE_FORMATO: registro ilegível: ${registro.slice(0, 80)}`);
  if (registro.length < 2 || registro[0] !== '(' || registro[registro.length - 1] !== ')') throw ilegivel();
  const campos: string[] = [];
  let atual = '';
  let aspas = false;
  const fim = registro.length - 1;
  for (let i = 1; i < fim; i += 1) {
    const ch = registro[i];
    if (aspas) {
      if (ch === '\\') {
        if (i + 1 >= fim) throw ilegivel();
        atual += registro[i + 1];
        i += 1;
      } else if (ch === '"') {
        if (registro[i + 1] === '"') {
          atual += '"';
          i += 1;
        } else {
          aspas = false;
        }
      } else {
        atual += ch;
      }
    } else if (ch === '"') {
      aspas = true;
    } else if (ch === ',') {
      campos.push(atual);
      atual = '';
    } else if (ch === '\\') {
      if (i + 1 >= fim) throw ilegivel();
      atual += registro[i + 1];
      i += 1;
    } else if (ch === '(' || ch === ')') {
      throw ilegivel();
    } else {
      atual += ch;
    }
  }
  if (aspas) throw ilegivel();
  campos.push(atual);
  return campos.join('|');
}

const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Valida a resposta e devolve as saídas por consulta. LANÇA (⇒ exit 2 no CLI) em qualquer dúvida:
 * cada ramo tem a sua marca ASCII, para que o teste case o MOTIVO e não só "lançou".
 */
export function lerDadosNuvem(
  bruto: string,
  esperado: { consultas: Consultas; consumidor: string },
  agora: Date,
): DadosNuvem {
  let valor: unknown;
  try {
    valor = JSON.parse(bruto);
  } catch {
    throw new Error('TRANSPORTE_FORMATO: o arquivo não é JSON — grave a resposta do query_database sem editar');
  }
  const p = desembrulhar(valor);

  if (p.formato !== FORMATO_TRANSPORTE) {
    throw new Error(`TRANSPORTE_FORMATO: formato ${JSON.stringify(p.formato)}, esperado ${FORMATO_TRANSPORTE}`);
  }
  if (p.consumidor !== esperado.consumidor) {
    throw new Error(
      `TRANSPORTE_FORMATO: resposta gerada para ${JSON.stringify(p.consumidor)}, não para ${esperado.consumidor} — arquivo de outra leitura`,
    );
  }
  const campos = ['medido_em', 'somente_leitura', 'teto', 'sql_md5', 'md5'] as const;
  for (const c of campos) {
    if (typeof p[c] !== 'string') throw new Error(`TRANSPORTE_FORMATO: campo '${c}' ausente ou não-texto`);
  }
  const s = p as Record<(typeof campos)[number], string> & { consultas?: unknown };

  const nomes = validarNomes(esperado.consultas, esperado.consumidor);
  const recebidas = s.consultas;
  if (recebidas === null || typeof recebidas !== 'object' || Array.isArray(recebidas)) {
    throw new Error("TRANSPORTE_CONSULTAS: campo 'consultas' ausente");
  }
  const chaves = Object.keys(recebidas).sort();
  if (chaves.join(',') !== nomes.join(',')) {
    throw new Error(`TRANSPORTE_CONSULTAS: a resposta traz [${chaves.join(', ')}], o CLI pede [${nomes.join(', ')}]`);
  }
  const linhasPor = new Map<string, string[]>();
  for (const n of nomes) {
    const linhas = (recebidas as Record<string, unknown>)[n];
    if (!Array.isArray(linhas) || !linhas.every((l) => typeof l === 'string')) {
      throw new Error(`TRANSPORTE_CONSULTAS: a consulta '${n}' não veio como lista de textos`);
    }
    linhasPor.set(n, linhas as string[]);
  }

  // 1º a integridade: sem ela, nenhum outro campo merece crédito (inclusive os que atestam).
  const canonico = [FORMATO_TRANSPORTE, esperado.consumidor, s.medido_em, s.somente_leitura, s.teto, s.sql_md5];
  for (const n of nomes) {
    const linhas = linhasPor.get(n) as string[];
    canonico.push(n, String(linhas.length), linhas.join('\n'));
  }
  if (md5(canonico.join('\n')) !== s.md5) {
    throw new Error(
      'TRANSPORTE_MD5: o md5 do payload não fecha — a resposta foi alterada na transcrição. ' +
        'Grave de novo, sem editar (ou rode o SQL de novo)',
    );
  }

  if (s.somente_leitura !== 'on') {
    throw new Error(
      `TRANSPORTE_SOMENTE_LEITURA: o banco disse transaction_read_only=${s.somente_leitura}. O SET TRANSACTION ` +
        'não pegou na transação do SELECT (statements enviados separados?) — leitura sem trava é recusada',
    );
  }
  if (s.teto !== TETO_TRANSPORTE) {
    throw new Error(`TRANSPORTE_TETO: statement_timeout=${s.teto}, esperado ${TETO_TRANSPORTE}`);
  }

  const emitido = gerarSqlNuvem(esperado.consultas, esperado.consumidor);
  if (md5(trechoMarcado(emitido)) !== s.sql_md5) {
    throw new Error(
      'TRANSPORTE_SQL_DIVERGENTE: o SQL que o banco executou não é o que o CLI emite agora — cópia não ' +
        'verbatim, ou a entrada mudou (a main andou?). Rode o --sql-nuvem de novo e cole SEM editar',
    );
  }

  if (!INSTANTE.test(s.medido_em)) throw new Error(`TRANSPORTE_FORMATO: medido_em ilegível: ${s.medido_em}`);
  const medidoEm = new Date(s.medido_em);
  const idadeMin = (agora.getTime() - medidoEm.getTime()) / 60_000;
  if (idadeMin > IDADE_MAXIMA_MIN) {
    throw new Error(
      `TRANSPORTE_VELHO: a leitura tem ${idadeMin.toFixed(1)} min (teto ${IDADE_MAXIMA_MIN}) — rode o SQL de novo`,
    );
  }
  if (idadeMin < -FOLGA_RELOGIO_MIN) {
    throw new Error(`TRANSPORTE_FUTURO: medido_em ${s.medido_em} está ${(-idadeMin).toFixed(1)} min no futuro`);
  }

  const saidas = new Map<string, string>();
  const linhas = new Map<string, readonly string[]>();
  for (const n of nomes) {
    const convertidas = (linhasPor.get(n) as string[]).map(registroParaLinha);
    linhas.set(n, convertidas);
    saidas.set(n, convertidas.join('\n'));
  }
  return { medidoEm, saidas, linhas };
}

/**
 * Separa `--sql-nuvem` e `--dados-nuvem[=| ]<arquivo>` do resto do argv. LANÇA se o caminho vier
 * vazio, se a flag se repetir ou se as duas metades vierem juntas — cada uma é uma rodada.
 */
export function separarFlagsNuvem(args: readonly string[]): {
  sqlNuvem: boolean;
  dadosNuvem: string | null;
  resto: string[];
} {
  let sqlNuvem = false;
  let dadosNuvem: string | null = null;
  const resto: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    let valor: string | undefined;
    if (arg === '--sql-nuvem') {
      sqlNuvem = true;
      continue;
    } else if (arg === '--dados-nuvem') {
      valor = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--dados-nuvem=')) {
      valor = arg.slice('--dados-nuvem='.length);
    } else {
      resto.push(arg);
      continue;
    }
    if (valor === undefined || valor.trim() === '') {
      throw new Error('--dados-nuvem veio sem o caminho do arquivo com a resposta do query_database');
    }
    if (dadosNuvem !== null) throw new Error('--dados-nuvem repetido: duas respostas são duas leituras');
    dadosNuvem = valor;
  }
  if (sqlNuvem && dadosNuvem !== null) {
    throw new Error('--sql-nuvem e --dados-nuvem são as duas metades da MESMA leitura — uma de cada vez');
  }
  return { sqlNuvem, dadosNuvem, resto };
}

/** Lê o arquivo do `--dados-nuvem`; ausência é mecânica, nunca "nada a relatar". */
export function lerArquivoDadosNuvem(caminho: string): string {
  try {
    return readFileSync(caminho, 'utf8');
  } catch (e) {
    throw new Error(`TRANSPORTE_ARQUIVO: não li ${caminho} (${(e as Error).message}) — sem a resposta da nuvem não há veredito`);
  }
}

/**
 * O substituto do `psql` para quem recebe a função de leitura por injeção: devolve a saída da
 * consulta pelo TEXTO do SQL. SQL fora do pacote LANÇA — consulta nova que não entrou no transporte
 * é mecânica, não resposta vazia.
 */
export function leitorNuvem(dados: DadosNuvem, consultas: Consultas): (sql: string) => string {
  const porSql = new Map<string, string>();
  for (const [nome, sql] of Object.entries(consultas)) {
    const saida = dados.saidas.get(nome);
    if (saida !== undefined) porSql.set(sql, saida);
  }
  return (sql: string) => {
    const saida = porSql.get(sql);
    if (saida === undefined) {
      throw new Error(
        `TRANSPORTE_FORA_DO_PACOTE: consulta sem resposta no transporte: ${sql.replace(/\s+/g, ' ').slice(0, 80)}…`,
      );
    }
    return saida;
  };
}
