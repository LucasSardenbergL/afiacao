/**
 * Helpers pra montar predicados do `.or()` do PostgREST (supabase-js) SEM abrir
 * brecha de injeção.
 *
 * O `.or('col.ilike.%termo%,outra.ilike.%termo%')` recebe uma string crua onde a
 * vírgula separa cláusulas, os parênteses agrupam, e `% _` são wildcards do ILIKE.
 * Se o `termo` vier do usuário sem escape, digitar algo como `x,id.gt.0` quebra a
 * `.ilike` e injeta um predicado extra — alargando o resultado / permitindo
 * enumerar dentro do que a RLS já libera.
 *
 * Regra do projeto (CLAUDE.md §9b): NUNCA interpolar input direto num `.or()` via
 * template literal — use estes helpers, que sanitizam. A regra ESLint
 * `no-restricted-syntax` bloqueia o padrão cru no CI.
 */

/**
 * Remove os caracteres com significado especial no parser do `.or()`: vírgula
 * (separador), parênteses (agrupamento), barra invertida (escape), aspas duplas
 * (delimitador de valor) e os wildcards do ILIKE (`%` `_` e `*`). O `*` entra
 * porque o PostgREST o trata como alias de `%` em like/ilike (truque pra evitar
 * URL-encoding do `%`); sem removê-lo, `a*b` viraria o padrão `%a%b%`. O texto
 * restante vira filtro literal — a busca continua sendo ILIKE parcial.
 */
export function sanitizeForPostgrestOr(input: string): string {
  return input.replace(/[%_,()\\"*]/g, '');
}

/** Uma cláusula `coluna.ilike.%termo%` com o termo sanitizado. */
export function ilike(column: string, term: string): string {
  return `${column}.ilike.%${sanitizeForPostgrestOr(term)}%`;
}

/**
 * Predicado OR de ILIKE do mesmo termo em várias colunas:
 * `c1.ilike.%t%,c2.ilike.%t%`. Atalho pro caso mais comum (busca textual).
 */
export function ilikeOr(columns: string[], term: string): string {
  const safe = sanitizeForPostgrestOr(term);
  return columns.map((c) => `${c}.ilike.%${safe}%`).join(',');
}

/**
 * Cláusula `coluna.eq.<inteiro>` pra colunas numéricas. Coage o termo a um
 * inteiro não-negativo; vira `0` quando não for só dígitos (não casa com nada,
 * que é o comportamento desejado pra busca por código numérico).
 */
export function eqInt(column: string, term: string): string {
  const t = term.trim();
  return `${column}.eq.${/^\d+$/.test(t) ? t : '0'}`;
}

/** Cláusula `coluna.eq.valor` (match exato) com o valor sanitizado. */
export function eqText(column: string, value: string): string {
  return `${column}.eq.${sanitizeForPostgrestOr(value)}`;
}

/** Junta cláusulas num predicado pronto pro `.or()`. */
export function orFilter(...clauses: string[]): string {
  return clauses.join(',');
}
