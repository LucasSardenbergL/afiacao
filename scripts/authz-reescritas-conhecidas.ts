/**
 * authz-reescritas-conhecidas.ts — baseline das migrations que recriam função do AUTHZ_MANIFEST
 * reescrevendo a definição VIVA (`pg_get_functiondef` + `EXECUTE`), sem `CREATE FUNCTION`.
 * ============================================================================================
 *
 * Para essas funções a **Parte A não mede a última definição** — ela mede o último `CREATE` que
 * existe como texto, e o banco tem outra coisa. A entrada aqui NÃO diz "está tudo bem": ela
 * DECLARA o não-medido, para que o verde do `authz:check` pare de afirmar cobertura que não tem.
 * Cada entrada vira AVISO no CI (visível, nomeando arquivo e função) em vez de erro.
 *
 * ⚠️ Migration committada é IMUTÁVEL neste repo, então "o autor reescreve como CREATE OR REPLACE"
 * só vale para o FUTURO. As entradas abaixo são o passado medido; qualquer reescrita NOVA de
 * função do manifest é ERRO até ser reescrita de forma auditável ou classificada aqui.
 *
 * `md5ProdEsperado` é o md5 do `prosrc` NORMALIZADO em produção, medido por `psql-ro`:
 *   md5(regexp_replace(btrim(prosrc), '\s+', ' ', 'g'))
 * O CI **não** confere (não tem prod). Quem confere é `bun run authz:audit:prod`, que também roda
 * o `checkGate` no corpo VIVO. É isso que fecha o laço: a baseline vira asserção verificável em
 * vez de desculpa, e drift futuro no corpo aparece como md5 divergente.
 *
 * 🔴 **A entrada TEM PRAZO, e ele não é uma data: é a chegada de um `CREATE` parseável posterior.**
 * Quando outra migration recria a função com `CREATE [OR REPLACE] FUNCTION` literal, a Parte A
 * volta a medir a última definição e a dívida está PAGA — a entrada tem de ser REMOVIDA no mesmo
 * PR. Deixá-la é pior que inútil: o `authz:check` emudece (a afirmação da Parte A virou
 * verdadeira), mas o `authz:audit:prod` continua exigindo o `md5ProdEsperado` de um corpo que não
 * existe mais, e o MD5_DIVERGIU resultante NOMEIA O ARQUIVO DESTA BASELINE — mandando investigar
 * uma migration inocente. Foi o que aconteceu com `get_defasagem_cliente` (05/09 → 07/09) e com
 * `get_preco_cockpit`; hoje quem cobra a poda é o `REESCRITA_BASELINE_OBSOLETA` da Parte D.
 * A memória do caso vai para `docs/historico/`, não para esta lista.
 */
export interface ReescritaConhecida {
  /** migration que faz a reescrita (o arquivo que a Parte A não consegue ler como definição) */
  arquivo: string;
  /** chave `schema.nome` do AUTHZ_MANIFEST */
  funcao: string;
  motivo: string;
  /** a prova que de fato mede o corpo que RODA (executada, não textual) */
  provaExecutada: string;
  /** md5 do prosrc normalizado em prod, medido 2026-08-14 por psql-ro */
  md5ProdEsperado: string;
}

// A última entrada (`20260814022626_reposicao_po_inexistente_antes_de.sql` · `reposicao_pos_candidatos`) saiu em
// 2026-10-01: a 20261001023000_hoje_sp_familia_data_ciclo.sql recria a função com CREATE OR REPLACE literal, e a
// Parte A voltou a medir a última definição (a dívida está PAGA — cabeçalho acima).
export const AUTHZ_REESCRITAS_CONHECIDAS: ReescritaConhecida[] = [];

/** chave de casamento — arquivo + função, porque uma migration pode reescrever várias */
export function chaveReescrita(arquivo: string, funcao: string): string {
  return `${arquivo}::${funcao}`;
}

export const REESCRITAS_CONHECIDAS_INDEX = new Map(
  AUTHZ_REESCRITAS_CONHECIDAS.map((r) => [chaveReescrita(r.arquivo, r.funcao), r]),
);
