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
 * O que o banco ATESTA, amarrado no md5 do payload:
 *   - `somente_leitura = on` — o `SET TRANSACTION` pegou na MESMA transação do SELECT. O
 *     `query_database` entra como `postgres`, com BYPASSRLS e sem modo leitura (piloto, Camada 3);
 *     o lote multi-statement é UMA transação implícita (medido lá e em prod, 2026-09-27), então a
 *     trava vale para tudo que vem DEPOIS dela no lote. Statements enviados separados fazem o SET
 *     virar no-op com WARNING e o SELECT dizer `off` — recusado.
 *   - `teto = 30s` — o `statement_timeout` do wrapper local, reposto por `SET LOCAL`.
 *   - `sql_md5` — md5 do texto executado do 1º caractere de `current_query()` até a marca final:
 *     cobre o PREFIXO, então um statement enfiado ANTES da trava muda o hash. Termina na marca, e
 *     não no fim do texto, porque o `query_database` ACRESCENTA ~105 caracteres depois do SQL
 *     (um rastro que termina num timestamp — medido em prod, 2026-09-27).
 *   - `marcas = 1/1` — o texto tem UMA marca de início e UMA de fim. Um lote com o SQL repetido
 *     ("sanduíche" com COMMIT no meio) acusaria 2/2.
 *   - `medido_em` — relógio do banco. Resposta de outra rodada, reaproveitada, não é medição desta.
 *
 * O que NÃO se prova aqui — e está escrito para ninguém contar com isso:
 *   - O md5 pega ERRO de transcrição (linha trocada, truncada), não FORJA: a sessão tem bash e a
 *     receita está neste arquivo. Por isso a regra do procedimento é "nunca monte, reconstrua nem
 *     calcule o payload; erro ou truncagem do `query_database` é mecânica" — e, quando o harness
 *     gravar o resultado da ferramenta em arquivo, passe ESSE arquivo ao `--dados-nuvem`.
 *   - O hash DETECTA escrita fora da trava; não a IMPEDE — ela já rodou quando a resposta chega.
 *   - Qual banco respondeu: `project_id` errado devolveria a resposta de outro Postgres, e ela
 *     passaria. Amarrar à identidade de prod (`system_identifier`) espera a medição de permissão.
 *
 * FIDELIDADE ao psql, para QUALQUER tipo: cada linha viaja como o literal de registro do próprio
 * Postgres (`ROW(alias.*)::text`, o `record_out`), que monta cada campo com a MESMA função de saída
 * do tipo que o psql imprime. O TS desfaz só o envelope do registro e junta os campos com `|`. A
 * consulta entra INTEIRA, com as quebras de linha dela, entre quebras de linha — juntar linhas
 * mudava o SQL em caso-limite (aspa em comentário, `$tag$`), e comentário `--` no fim engoliria o
 * fecha-parêntese. Os nomes internos vivem no prefixo `__sql_nuvem_` para não sombrear tabela ou
 * coluna da consulta. A prova contra um Postgres de verdade é `db/test-transporte-nuvem.sh`.
 *
 * SONDAS EXECUTIVAS (2026-10-01) — a leitura que só prova alguma coisa RODANDO COMO outro papel, e
 * cujo resultado esperado pode ser um ERRO (a sentinela do `claude_ro`: "catálogo não prova
 * alcance"). Nenhuma das duas coisas cabe numa consulta do pacote: o canal entra como `postgres`, e
 * um erro aborta o lote inteiro. Então o SQL ganha um PREÂMBULO fixo, gerado aqui, entre a trava e o
 * `WITH`: um `DO` que roda cada sonda num sub-bloco com `SET LOCAL ROLE`, por `EXECUTE` (statement de
 * topo, como o psql a mandaria: sem embrulho, o planner não poda coluna) e guarda o desfecho num GUC
 * de transação; as consultas reservadas `sonda__<nome>` o leem. O que o desenho garante, e o porquê:
 *   - o preâmbulo fica DEPOIS da trava e DENTRO do trecho do `sql_md5`: roda sob READ ONLY, e
 *     qualquer byte trocado nele recusa a leitura;
 *   - o sub-bloco termina SEMPRE em exceção (a da sonda, ou uma forçada depois dela): o rollback da
 *     subtransação desfaz o `SET LOCAL ROLE`, e o `WITH` roda de volta como o canal;
 *   - a ETAPA separa "não virou o papel" de "a sonda falhou como o papel". Sem ela, o `SET ROLE`
 *     negado (SQLSTATE 42501) seria lido como a negação ESPERADA de uma sonda que nem rodou — o
 *     falso verde perfeito. Desfecho sem o papel nunca vira resultado: `TRANSPORTE_SONDA_PAPEL`;
 *   - sonda que RODA devolve só `RODOU`, nunca o dado — salvo `devolverValor` (a 1ª coluna da 1ª
 *     linha, para uma contagem). Se a sonda do vault um dia voltar a ler, o segredo não sai do banco.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const FORMATO_TRANSPORTE = 'transporte-nuvem/2';

/** O `statement_timeout` do `psqlrc-ro` local — a nuvem não ganha teto mais frouxo que o Mac. */
export const TETO_TRANSPORTE = '30s';

/** Resposta mais velha que isto não é medição DESTA rodada (o coletor do ledger tolera 45 min). */
export const IDADE_MAXIMA_MIN = 30;

/** Relógio do banco à frente do local além disto é dado que não se explica — recusa. */
const FOLGA_RELOGIO_MIN = 5;

const MARCA_INICIO = 'sql-nuvem:inicio';
const MARCA_FIM = 'sql-nuvem:fim';
const PREFIXO_MARCA = 'sql-nuvem';
/** O namespace dos nomes internos (CTEs e aliases). Consulta que o contenha é recusada. */
const PREFIXO_INTERNO = '__sql_nuvem_';

/** A 1ª linha do SQL emitido: a trava e o teto, antes de qualquer outra coisa. */
const TRAVA = `SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '${TETO_TRANSPORTE}';`;

/** `json_build_object`/`concat_ws` param 100 argumentos no máximo; 30 consultas cabem com folga. */
const MAX_CONSULTAS = 30;
const NOME_CONSULTA = /^[a-z][a-z0-9_]{0,40}$/;
const NOME_CONSUMIDOR = /^[a-z][a-z0-9-]{0,60}$/;

/** O papel de uma sonda executiva: identificador sem aspas, como o `SET ROLE` o recebe. */
const NOME_PAPEL = /^[a-z_][a-z0-9_]{0,62}$/;
/** Cabe no `NOME_CONSULTA` depois do prefixo da consulta que lê o desfecho. */
const NOME_SONDA = /^[a-z][a-z0-9_]{0,33}$/;
/** As consultas que leem o desfecho das sondas — prefixo RESERVADO: consulta do CLI com ele é recusada. */
const PREFIXO_LEITURA_SONDA = 'sonda__';
/** O namespace dos GUCs de transação onde o preâmbulo deixa o desfecho de cada sonda. */
const GUC_SONDA = 'nuvem_sonda';

/** Nome curto → SQL de UMA consulta, exatamente como o CLI a passaria ao `psql -c`. */
export type Consultas = Readonly<Record<string, string>>;

/** Uma sonda executiva: o SQL, como o CLI o passaria ao `psql -c`, rodado COMO o papel. */
export interface SondaExecutiva {
  sql: string;
  /** Traz de volta a 1ª coluna da 1ª linha quando a sonda RODA — só para o que pode ir à transcrição
   *  (uma contagem). Sem isto, sonda que roda devolve só `RODOU`: nunca o dado. */
  devolverValor?: boolean;
}

/** As sondas de uma leitura e o papel sob o qual TODAS rodam. */
export interface SondasExecutivas {
  papel: string;
  sondas: Readonly<Record<string, SondaExecutiva>>;
}

/** O desfecho de uma sonda que rodou COMO o papel. "Não virou o papel" não é desfecho: LANÇA. */
export type ResultadoSonda =
  | { tipo: 'rodou'; valor: string }
  | { tipo: 'erro'; sqlstate: string; mensagem: string };

export interface DadosNuvem {
  /** O `now()` do banco na transação da leitura — a idade de cada linha é relativa a ele. */
  medidoEm: Date;
  /** Por NOME de consulta: as linhas unidas por `\n`, na forma que o `psql -A -F '|' -t` imprime
   *  (o payload traz o literal de registro; a conversão é `registroParaLinha`). */
  saidas: ReadonlyMap<string, string>;
  /** As mesmas linhas, uma por registro — preserva "1 linha vazia" ≠ "0 linhas", que `saidas` funde. */
  linhas: ReadonlyMap<string, readonly string[]>;
  /** Por nome de SONDA, o desfecho dela rodando como o papel (vazio sem sondas). */
  sondas: ReadonlyMap<string, ResultadoSonda>;
}

function md5(texto: string): string {
  return createHash('md5').update(texto, 'utf8').digest('hex');
}

/**
 * A consulta como ela vai embutida: o texto dela, INTEIRO, sem o `;` final — sem juntar linhas.
 *
 * Recusa (em vez de "consertar"): `;` no meio (o transporte embute cada consulta num statement só),
 * as marcas e o namespace interno, e caractere de controle que não seja a quebra de linha — `\r` e
 * tabulação são o tipo de byte que um transporte normaliza no caminho, e o `sql_md5` recusaria a
 * leitura inteira por isso. Recusar aqui é falhar na MÁQUINA de quem escreveu a consulta.
 */
/** Caractere de controle que não seja a quebra de linha (`\n` fica: a consulta vai inteira). */
// eslint-disable-next-line no-control-regex -- é exatamente o que a guarda procura (recusa, não strip)
const CONTROLE = /[\x00-\x09\x0b-\x1f\x7f]/;

function normalizarConsulta(nome: string, sql: string): string {
  const recusa = (motivo: string) =>
    new Error(`TRANSPORTE_CONSULTA_INVALIDA: a consulta '${nome}' ${motivo}`);
  let corpo = sql.trim();
  if (corpo.endsWith(';')) corpo = corpo.slice(0, -1).trimEnd();
  if (corpo === '') throw recusa('veio vazia');
  if (corpo.includes(';')) throw recusa("tem ';' no meio — o transporte embute cada consulta num statement só");
  if (corpo.includes(PREFIXO_MARCA)) throw recusa(`contém '${PREFIXO_MARCA}', a marca do transporte`);
  if (corpo.includes(PREFIXO_INTERNO)) throw recusa(`contém '${PREFIXO_INTERNO}', o namespace interno do transporte`);
  if (CONTROLE.test(corpo)) throw recusa('tem caractere de controle além da quebra de linha');
  return corpo;
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

/**
 * As consultas do CLI mais as que leem o desfecho de cada sonda (`sonda__<nome>`). O prefixo é
 * reservado SEMPRE — com ou sem sondas — para que uma consulta do CLI nunca se passe por desfecho.
 */
function comLeituraDasSondas(consultas: Consultas, sondas: SondasExecutivas | undefined): Consultas {
  const recusa = (motivo: string) => new Error(`TRANSPORTE_CONSULTA_INVALIDA: ${motivo}`);
  const reservadas = Object.keys(consultas).filter((n) => n.startsWith(PREFIXO_LEITURA_SONDA));
  if (reservadas.length > 0) {
    throw recusa(`o prefixo '${PREFIXO_LEITURA_SONDA}' é do desfecho das sondas: ${reservadas.join(', ')}`);
  }
  if (sondas === undefined) return consultas;
  if (!NOME_PAPEL.test(sondas.papel)) throw recusa(`papel das sondas fora do formato: ${JSON.stringify(sondas.papel)}`);
  const nomes = Object.keys(sondas.sondas);
  if (nomes.length === 0) throw recusa('sondas executivas declaradas sem sonda nenhuma');
  const ruins = nomes.filter((n) => !NOME_SONDA.test(n));
  if (ruins.length > 0) throw recusa(`nome(s) de sonda fora do formato: ${ruins.join(', ')}`);
  const leitura: Record<string, string> = {};
  for (const n of nomes) {
    normalizarConsulta(n, sondas.sondas[n].sql); // as MESMAS recusas de uma consulta — antes de embutir
    leitura[`${PREFIXO_LEITURA_SONDA}${n}`] = `SELECT current_setting('${GUC_SONDA}.${n}', true) AS desfecho`;
  }
  return { ...consultas, ...leitura };
}

/**
 * O `DO` que roda cada sonda COMO o papel e deixa o desfecho num GUC de transação — o porquê de cada
 * linha está no cabeçalho. Desfechos: `RODOU|<valor>` (a sonda chegou ao fim), `ERRO|<sqlstate>|<msg>`
 * (falhou JÁ como o papel), `PAPEL|<sqlstate>|<msg>` (não virou o papel: a sonda não rodou).
 */
function preambuloDasSondas(s: SondasExecutivas): string {
  const linhas = [
    'DO $__sql_nuvem_sondas__$',
    'DECLARE __sql_nuvem_etapa__ text; __sql_nuvem_valor__ text;',
    'BEGIN',
  ];
  for (const n of Object.keys(s.sondas).sort()) {
    const { sql, devolverValor } = s.sondas[n];
    linhas.push(
      `__sql_nuvem_etapa__ := 'papel'; __sql_nuvem_valor__ := NULL;`,
      'BEGIN',
      `SET LOCAL ROLE ${s.papel};`,
      `IF current_user <> '${s.papel}' THEN RAISE EXCEPTION 'o papel nao trocou'; END IF;`,
      `__sql_nuvem_etapa__ := 'sonda';`,
      `EXECUTE $__sql_nuvem_q__$\n${normalizarConsulta(n, sql)}\n$__sql_nuvem_q__$${devolverValor === true ? ' INTO __sql_nuvem_valor__' : ''};`,
      `__sql_nuvem_etapa__ := 'rodou';`,
      // Sempre termina em exceção: o rollback do sub-bloco é o que desfaz o SET LOCAL ROLE.
      `RAISE EXCEPTION 'desfaz o papel';`,
      'EXCEPTION WHEN OTHERS THEN',
      `PERFORM set_config('${GUC_SONDA}.${n}', CASE __sql_nuvem_etapa__` +
        ` WHEN 'rodou' THEN 'RODOU|' || coalesce(__sql_nuvem_valor__, '')` +
        ` WHEN 'sonda' THEN 'ERRO|' || SQLSTATE || '|' || SQLERRM` +
        ` ELSE 'PAPEL|' || SQLSTATE || '|' || SQLERRM END, true);`,
      'END;',
    );
  }
  linhas.push('END $__sql_nuvem_sondas__$;');
  return linhas.join('\n');
}

/**
 * O desfecho que o preâmbulo deixou para a sonda `nome` (a linha da consulta `sonda__<nome>`).
 * LANÇA no que não é desfecho de sonda que rodou como o papel — nunca vira resultado.
 */
function lerDesfecho(nome: string, papel: string, linhas: readonly string[]): ResultadoSonda {
  if (linhas.length !== 1) {
    throw new Error(`TRANSPORTE_SONDA: o desfecho da sonda '${nome}' veio com ${linhas.length} linha(s), esperado 1`);
  }
  const [tipo, ...resto] = linhas[0].split('|');
  if (tipo === 'RODOU') return { tipo: 'rodou', valor: resto.join('|') };
  if (tipo === 'ERRO' && /^[0-9A-Z]{5}$/.test(resto[0] ?? '')) {
    return { tipo: 'erro', sqlstate: resto[0], mensagem: resto.slice(1).join('|') };
  }
  if (tipo === 'PAPEL') {
    throw new Error(
      `TRANSPORTE_SONDA_PAPEL: a sonda '${nome}' NÃO rodou como ${papel} (${resto.join(': ')}) — o canal não ` +
        `conseguiu virar o papel, e sem ele nenhuma resposta da sonda é veredito. O canal precisa de SET em ${papel}`,
    );
  }
  if (linhas[0] === '') {
    throw new Error(`TRANSPORTE_SONDA: a sonda '${nome}' não deixou desfecho — o preâmbulo não rodou no lote`);
  }
  throw new Error(`TRANSPORTE_FORMATO: desfecho ilegível da sonda '${nome}': ${linhas[0].slice(0, 80)}`);
}

/** A marca montada em duas metades: o texto contíguo dela só existe UMA vez no SQL emitido. */
function marcaPartida(marca: string): string {
  return `'${PREFIXO_MARCA}' || '${marca.slice(PREFIXO_MARCA.length)}'`;
}

/** Quantas vezes a marca aparece em `current_query()`. */
function ocorrencias(marca: string): string {
  return (
    `((length(current_query()) - length(replace(current_query(), ${marcaPartida(marca)}, '')))` +
    ` / ${marca.length})`
  );
}

/**
 * O SQL que o modelo roda pelo `query_database`. Determinístico: mesmas consultas → mesmo texto
 * (é o que deixa o `--dados-nuvem` refazê-lo e conferir o `sql_md5`).
 */
export function gerarSqlNuvem(consultas: Consultas, consumidor: string, sondas?: SondasExecutivas): string {
  const todas = comLeituraDasSondas(consultas, sondas);
  const nomes = validarNomes(todas, consumidor);
  const corpos = nomes.map((n) => normalizarConsulta(n, todas[n]));
  const fimDoTrecho = `position(${marcaPartida(MARCA_FIM)} IN current_query()) + ${MARCA_FIM.length - 1}`;

  const colunas = nomes.map(
    (n, i) =>
      `(SELECT coalesce(array_agg(__sql_nuvem_agg__.l), ARRAY[]::text[]) FROM ` +
      `(SELECT ROW(__sql_nuvem_linha__.*)::text AS l FROM (\n${corpos[i]}\n) AS __sql_nuvem_linha__) ` +
      `AS __sql_nuvem_agg__) AS c_${n}`,
  );
  const canonico = [
    `'${FORMATO_TRANSPORTE}'`,
    `'${consumidor}'`,
    'm.medido_em',
    'm.somente_leitura',
    'm.teto',
    'm.sql_md5',
    'm.marcas',
    ...nomes.flatMap((n) => [`'${n}'`, `cardinality(c.c_${n})::text`, `array_to_string(c.c_${n}, E'\\n')`]),
  ];
  const objeto = nomes.map((n) => `'${n}', to_json(c.c_${n})`).join(', ');

  const sql = [
    TRAVA,
    ...(sondas === undefined ? [] : [preambuloDasSondas(sondas)]),
    `WITH __sql_nuvem_marca__ AS (SELECT '${MARCA_INICIO}'::text AS inicio),`,
    `__sql_nuvem_meta__ AS (SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS medido_em,`,
    `current_setting('transaction_read_only') AS somente_leitura, current_setting('statement_timeout') AS teto,`,
    `md5(substring(current_query() FROM 1 FOR ${fimDoTrecho})) AS sql_md5,`,
    `${ocorrencias(MARCA_INICIO)}::text || '/' || ${ocorrencias(MARCA_FIM)}::text AS marcas),`,
    `__sql_nuvem_consultas__ AS (SELECT`,
    colunas.join(',\n'),
    `)`,
    `SELECT json_build_object('formato', '${FORMATO_TRANSPORTE}', 'consumidor', '${consumidor}',`,
    `'medido_em', m.medido_em, 'somente_leitura', m.somente_leitura, 'teto', m.teto,`,
    `'sql_md5', m.sql_md5, 'marcas', m.marcas, 'consultas', json_build_object(${objeto}),`,
    `'md5', md5(concat_ws(E'\\n', ${canonico.join(', ')}))) AS dados_nuvem`,
    `FROM __sql_nuvem_marca__, __sql_nuvem_meta__ AS m, __sql_nuvem_consultas__ AS c,`,
    `(SELECT '${MARCA_FIM}'::text AS fim) AS __sql_nuvem_marca_fim__;`,
  ].join('\n');
  // O que a conferência do `sql_md5` pressupõe, conferido na GERAÇÃO: cada marca uma vez só.
  if (sql.split(MARCA_INICIO).length !== 2 || sql.split(MARCA_FIM).length !== 2) {
    throw new Error('TRANSPORTE_CONSULTA_INVALIDA: o SQL emitido não tem exatamente uma marca de início e uma de fim');
  }
  return sql;
}

/** O trecho que o `sql_md5` cobre — a mesma conta que o banco faz: do 1º caractere até a marca final. */
function trechoMarcado(sql: string): string {
  const f = sql.indexOf(MARCA_FIM);
  if (f < 0) throw new Error('TRANSPORTE_SQL_DIVERGENTE: o SQL não tem a marca final do transporte');
  return sql.slice(0, f + MARCA_FIM.length);
}

/**
 * Tira o payload das embalagens em que ele pode chegar: o objeto puro, a resposta inteira do
 * `query_database` (`{"rows":[{"dados_nuvem":…}]}`), o valor como string JSON, ou os blocos de
 * conteúdo de um resultado de ferramenta que o harness gravou em disco. Ser tolerante AQUI não
 * afrouxa nada: o que decide são as conferências logo abaixo.
 */
function desembrulhar(valor: unknown, profundidade = 0): Record<string, unknown> {
  const falha = () =>
    new Error(
      'TRANSPORTE_FORMATO: não achei o objeto do transporte no arquivo — grave o valor da coluna ' +
        '`dados_nuvem` (o JSON com "formato":"transporte-nuvem/…") ou a resposta inteira do query_database',
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

/**
 * Valida a resposta e devolve as saídas por consulta. LANÇA (⇒ exit 2 no CLI) em qualquer dúvida:
 * cada ramo tem a sua marca ASCII, para que o teste case o MOTIVO e não só "lançou".
 */
export function lerDadosNuvem(
  bruto: string,
  esperado: { consultas: Consultas; consumidor: string; sondas?: SondasExecutivas },
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
  const campos = ['medido_em', 'somente_leitura', 'teto', 'sql_md5', 'marcas', 'md5'] as const;
  for (const c of campos) {
    if (typeof p[c] !== 'string') throw new Error(`TRANSPORTE_FORMATO: campo '${c}' ausente ou não-texto`);
  }
  const s = p as Record<(typeof campos)[number], string> & { consultas?: unknown };

  const nomes = validarNomes(comLeituraDasSondas(esperado.consultas, esperado.sondas), esperado.consumidor);
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
  const canonico = [FORMATO_TRANSPORTE, esperado.consumidor, s.medido_em, s.somente_leitura, s.teto, s.sql_md5, s.marcas];
  for (const n of nomes) {
    const linhas = linhasPor.get(n) as string[];
    canonico.push(n, String(linhas.length), linhas.join('\n'));
  }
  if (md5(canonico.join('\n')) !== s.md5) {
    throw new Error(
      'TRANSPORTE_MD5: o md5 do payload não fecha — a resposta foi alterada ou truncada na transcrição. ' +
        'Rode o SQL de novo e grave a resposta sem editar; nunca a reconstrua',
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
  if (s.marcas !== '1/1') {
    throw new Error(
      `TRANSPORTE_SQL_DIVERGENTE: o texto executado tem ${s.marcas} marcas (início/fim), esperado 1/1 — ` +
        'o lote carregava o SQL do transporte mais de uma vez',
    );
  }

  const emitido = gerarSqlNuvem(esperado.consultas, esperado.consumidor, esperado.sondas);
  if (md5(trechoMarcado(emitido)) !== s.sql_md5) {
    throw new Error(
      'TRANSPORTE_SQL_DIVERGENTE: o SQL que o banco executou não é o que o CLI emite agora — cópia não ' +
        'verbatim, statement antes da trava, ou a entrada mudou (a main andou?). Rode o --sql-nuvem de novo e cole SEM editar',
    );
  }

  const medidoEm = new Date(s.medido_em);
  // Ida e volta: só vale o instante que volta IGUAL ao texto que o banco escreveu (`to_char` com
  // `YYYY-MM-DD"T"HH24:MI:SS"Z"`). Pega o formato errado E o dia impossível, que o `Date` aceita e
  // normaliza em silêncio (30/02 vira 02/03).
  const legivel =
    Number.isFinite(medidoEm.getTime()) && medidoEm.toISOString() === s.medido_em.replace(/Z$/, '.000Z');
  if (!legivel) throw new Error(`TRANSPORTE_FORMATO: medido_em ilegível: ${s.medido_em}`);
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
  const sondas = new Map<string, ResultadoSonda>();
  for (const n of nomes) {
    const convertidas = (linhasPor.get(n) as string[]).map(registroParaLinha);
    if (esperado.sondas !== undefined && n.startsWith(PREFIXO_LEITURA_SONDA)) {
      const sonda = n.slice(PREFIXO_LEITURA_SONDA.length);
      sondas.set(sonda, lerDesfecho(sonda, esperado.sondas.papel, convertidas));
      continue;
    }
    linhas.set(n, convertidas);
    saidas.set(n, convertidas.join('\n'));
  }
  return { medidoEm, saidas, linhas, sondas };
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
