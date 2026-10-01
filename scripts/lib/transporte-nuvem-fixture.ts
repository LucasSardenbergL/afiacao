/**
 * transporte-nuvem-fixture.ts — a resposta do `query_database` montada como o BANCO a montaria, para
 * os testes que comparam o caminho do `psql-ro` com o da nuvem (`--dados-nuvem`) sobre a MESMA prod.
 *
 * Um mundo de teste é uma lista de linhas por consulta, cada linha uma lista de CAMPOS. Das mesmas
 * linhas saem as duas leituras: a que o `psql -A -F '|' -t` imprimiria (`linhaDoPsql`) e a que o
 * transporte traria (`registroDoBanco` + `respostaDoBanco`). Veredito diferente entre as duas é o
 * transporte virando outro juiz.
 *
 * A conta é refeita AQUI, à parte da lib que ela testa (`transporte-nuvem.ts`): o `record_out` e os
 * dois md5 seguem o que o Postgres faz. Que o banco de verdade faz isso mesmo, quem mede é a prova
 * PG `db/test-transporte-nuvem.sh`, byte a byte.
 */
import { createHash } from 'node:crypto';

import { FORMATO_TRANSPORTE, TETO_TRANSPORTE } from './transporte-nuvem';

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

/** O `isspace` do `record_out` no locale C: só os seis espaços ASCII. */
const PEDE_ASPAS = /[",\\() \t\n\v\f\r]/;

/**
 * O literal de registro que `ROW(x.*)::text` devolve (`record_out`): NULL é campo vazio sem aspas;
 * texto vazio, ou com `"`, `\`, `(`, `)`, `,` ou espaço ASCII, vai entre aspas, com `"` e `\` dobrados.
 */
export function registroDoBanco(campos: readonly (string | null)[]): string {
  const campo = (c: string | null): string => {
    if (c === null) return '';
    if (c !== '' && !PEDE_ASPAS.test(c)) return c;
    return `"${c.replace(/["\\]/g, (ch) => ch + ch)}"`;
  };
  return `(${campos.map(campo).join(',')})`;
}

/** A linha que o `psql -A -F '|' -t` imprime para os mesmos campos (sem `\pset null`: NULL = vazio). */
export function linhaDoPsql(campos: readonly (string | null)[]): string {
  return campos.map((c) => c ?? '').join('|');
}

/** Do 1º caractere até o fim da marca final — o trecho que o banco hasheia (o rastro do MCP fica fora). */
function trechoDoBanco(sql: string): string {
  const fim = 'sql-nuvem:fim';
  return sql.slice(0, sql.indexOf(fim) + fim.length);
}

/**
 * O JSON que o `query_database` devolveria para `sqlExecutado`, com os registros dados por consulta,
 * embrulhado como a ferramenta o entrega (`{"rows":[{"dados_nuvem":…}]}`). `campos` sobrepõe um
 * atestado (para os testes que exigem a RECUSA dele).
 */
export function respostaDoBanco(o: {
  sqlExecutado: string;
  consumidor: string;
  registros: Readonly<Record<string, readonly string[]>>;
  medidoEm: string;
  campos?: Partial<Record<'somente_leitura' | 'teto' | 'marcas', string>>;
}): string {
  const somenteLeitura = o.campos?.somente_leitura ?? 'on';
  const teto = o.campos?.teto ?? TETO_TRANSPORTE;
  const marcas = o.campos?.marcas ?? '1/1';
  const sqlMd5 = md5(trechoDoBanco(o.sqlExecutado));
  const canonico = [FORMATO_TRANSPORTE, o.consumidor, o.medidoEm, somenteLeitura, teto, sqlMd5, marcas];
  for (const nome of Object.keys(o.registros).sort()) {
    const linhas = o.registros[nome];
    canonico.push(nome, String(linhas.length), linhas.join('\n'));
  }
  const dados = {
    formato: FORMATO_TRANSPORTE,
    consumidor: o.consumidor,
    medido_em: o.medidoEm,
    somente_leitura: somenteLeitura,
    teto,
    sql_md5: sqlMd5,
    marcas,
    consultas: o.registros,
    md5: md5(canonico.join('\n')),
  };
  return JSON.stringify({ rows: [{ dados_nuvem: dados }] });
}
