#!/usr/bin/env bun
/**
 * transporte-nuvem-prova.ts — o lado TS da prova `db/test-transporte-nuvem.sh`.
 *
 * Só builtins `node:*` e o módulo que ela prova: roda no job `provas-sql` sem `bun install` (o
 * precedente é `gerar-canaria-fixture.ts`). As consultas NÃO são as do `pendencias:deploy` — são as
 * formas que quebram um transporte ingênuo, porque o que se prova aqui é a FIDELIDADE do transporte
 * para qualquer tipo, não o conteúdo de um CLI.
 *
 *   bun db/lib/transporte-nuvem-prova.ts consultas <dir>   # grava <dir>/<nome>.sql
 *   bun db/lib/transporte-nuvem-prova.ts sql               # o SQL do transporte (a 1ª linha é a trava)
 *   bun db/lib/transporte-nuvem-prova.ts ler <arq> <dir>   # valida; grava <dir>/<nome>.nuvem
 *
 * O `.nuvem` sai no formato exato do `psql -A -F '|' -t` (cada linha terminada em `\n`, nada para
 * zero linhas), para a prova comparar com `cmp`. Recusa do transporte: exit 3 + a marca no stderr.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Consultas,
  gerarSqlNuvem,
  lerArquivoDadosNuvem,
  lerDadosNuvem,
} from '../../scripts/lib/transporte-nuvem';

const CONSUMIDOR = 'prova-transporte';

const CONSULTAS: Consultas = {
  // aspas, barra, parênteses, vírgula, espaço, vazio × NULL, quebra de linha DENTRO do campo,
  // boolean, timestamp com microssegundo e infinity, array (vazio, com NULL, 2-D), jsonb, bigint
  // fora do inteiro seguro do JS e o mínimo do bigint
  tipos: 'SELECT t, n, b, ts, arr, j, bi FROM prova_tipos ORDER BY id',
  // a forma do ledger do `pendencias:deploy`: DISTINCT ON + to_char + numeric arredondado
  estilo_ledger:
    "SELECT DISTINCT ON (edge) edge, versao, to_char(observado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI\"Z\"'), " +
    "round((extract(epoch FROM (timestamptz '2026-09-27 12:00:00+00' - observado_em)) / 3600.0)::numeric, 2) " +
    'FROM prova_ledger ORDER BY edge, observado_em DESC',
  nula: 'SELECT NULL::text',
  vazia: 'SELECT 1 WHERE false',
  // não-ASCII no TEXTO do SQL (a amostra do autoteste do pacote): o `sql_md5` conta caractere no
  // banco e unidade UTF-16 no JS — só a prova de ponta a ponta diz que os dois batem
  utf8: "SELECT md5(E'\\n á  b '), 'ç'::text",
  // nomes que um transporte ingênuo usa por dentro: a tabela `marca` e as colunas `q`, `l`, `m`, `c`.
  // Se o SQL do transporte os usasse (a v1 usava `marca` e `q`), a consulta leria o CTE dele, não
  // a tabela — dado errado sem erro nenhum
  colisao: 'SELECT * FROM marca ORDER BY 1',
  // o que a v1 recusava por juntar as linhas: comentário de linha no fim, comentário de bloco com
  // aspa, dollar-quoting e literal atravessando a quebra, aspa escapada por barra
  multilinha:
    "SELECT /* it's */ $q1$a\nb$q1$ AS dollar,\n" +
    "E'x\\'y' AS escapada,\n" +
    "'atravessa\nlinha' AS literal -- comentário no fim",
};

function main(argv: string[]): number {
  const [modo, a, b] = argv;
  if (modo === 'consultas' && a) {
    mkdirSync(a, { recursive: true });
    for (const [nome, sql] of Object.entries(CONSULTAS)) writeFileSync(join(a, `${nome}.sql`), sql, 'utf8');
    return 0;
  }
  if (modo === 'sql') {
    process.stdout.write(`${gerarSqlNuvem(CONSULTAS, CONSUMIDOR)}\n`);
    return 0;
  }
  if (modo === 'ler' && a && b) {
    let dados: ReturnType<typeof lerDadosNuvem>;
    try {
      dados = lerDadosNuvem(lerArquivoDadosNuvem(a), { consultas: CONSULTAS, consumidor: CONSUMIDOR }, new Date());
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 3;
    }
    mkdirSync(b, { recursive: true });
    for (const [nome, linhas] of dados.linhas) {
      writeFileSync(join(b, `${nome}.nuvem`), linhas.map((l) => `${l}\n`).join(''), 'utf8');
    }
    return 0;
  }
  process.stderr.write('uso: transporte-nuvem-prova.ts consultas <dir> | sql | ler <arquivo> <dir>\n');
  return 2;
}

process.exit(main(process.argv.slice(2)));
