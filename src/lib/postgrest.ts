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

/**
 * `true` quando `term` ainda tem conteúdo após `sanitizeForPostgrestOr` — i.e. gera um predicado
 * `.or()` de ILIKE útil. `false` no caso DEGENERADO: termo vazio OU só-de-metacaracteres do `.or()`
 * (`*`, `%%`, `**`, `(),`…), em que `ilikeOr`/`ilike` colapsariam pra `col.ilike.%%` = match-all dos
 * valores não-nulos da coluna. Como o `.or(pred)` não tem como virar no-op por dentro (string vazia
 * não dropa o filtro), a defesa vive no CALLER, que gateia o `.or()` por isto:
 *   - lista c/ filtro opcional → `if (isSearchablePostgrestTerm(t)) q = q.or(…)` (senão = lista base)
 *   - busca pura            → `if (!isSearchablePostgrestTerm(t)) return []` (senão = linhas arbitrárias)
 * É o análogo, no contexto `.or()`, do `ilikeContainsPattern(t) === null` do `.ilike()` único (#1062);
 * um booleano (não pattern-or-null) porque a condição degenerada — `sanitizeForPostgrestOr(term)===''`
 * — é a MESMA pras 3 formas de `.or()` com ilike, inclusive o `orFilter` misto (eqInt+ilike), onde
 * não há um pattern único a retornar (aí o eqInt vira `eq.0`, inerte, e dropar o `.or()` é correto).
 */
export function isSearchablePostgrestTerm(term: string): boolean {
  return sanitizeForPostgrestOr(term) !== '';
}

/**
 * Sanitiza um termo pra um `.ilike(coluna, `%${termo}%`)` ÚNICO (fora de `.or()`).
 * Remove só os wildcards do operador LIKE/ILIKE: `%` (qualquer sequência), `_` (um
 * caractere) e `*` — alias de `%` que o PostgREST aceita pra evitar URL-encoding (logo
 * `*` do usuário vira `%*%` → `%%%` = match-all dos valores não-nulos da coluna). Strippar
 * só `%`/`_` (intuição) NÃO cobre o `*`: foi esse o gap nos `.ilike()` crus.
 *
 * Ao contrário do sanitizeForPostgrestOr, NÃO remove vírgula/parênteses/aspas: num `.ilike()`
 * único o pattern é o valor de UM predicado — não há parsing de cláusula (isso é exclusivo
 * do `.or()`), então esses caracteres são literais legítimos da busca e devem sobreviver.
 */
export function sanitizeIlikeTerm(input: string): string {
  return input.replace(/[%_*]/g, '');
}

/**
 * Pattern `%termo%` pra um `.ilike(coluna, …)` de "contém", com o termo sanitizado
 * (`sanitizeIlikeTerm`) — ou `null` quando o termo fica VAZIO após sanitizar (input vazio
 * OU só-de-wildcards: `*`, `%`, `_`, `**`, …). Os callers DEVEM gatear:
 * `const p = ilikeContainsPattern(t); if (p) q = q.ilike(col, p)`. Retornar null evita o
 * `%${''}%` = `%%`, que casaria todo valor não-nulo da coluna (match-all) — o caso degenerado
 * do wildcard-only input, que strippar os wildcards do MEIO do termo sozinho não cobre.
 */
export function ilikeContainsPattern(input: string): string | null {
  const safe = sanitizeIlikeTerm(input);
  return safe ? `%${safe}%` : null;
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
