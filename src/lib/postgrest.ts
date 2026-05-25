/**
 * Sanitiza input do usuário pra interpolar com segurança numa string de `.or()`
 * do PostgREST (supabase-js).
 *
 * O `.or('col.ilike.%termo%,outra.ilike.%termo%')` recebe uma string crua onde a
 * vírgula separa cláusulas, os parênteses agrupam, e `% _` são wildcards do ILIKE.
 * Se o `termo` vier do usuário sem escape, digitar algo como `x,id.gt.0` quebra a
 * `.ilike` e injeta um predicado extra — alargando o resultado / permitindo
 * enumerar dentro do que a RLS já libera.
 *
 * Remove os caracteres que têm significado especial no parser: vírgula (separador),
 * parênteses (agrupamento), barra invertida (escape), aspas duplas (delimitador de
 * valor) e os wildcards do ILIKE (`%` `_`). O texto restante vira filtro literal.
 *
 * Aplique SÓ na parte que vem de input do usuário, preservando a sintaxe do `.or()`:
 *   const q = sanitizeForPostgrestOr(busca);
 *   .or(`nome.ilike.%${q}%,doc.ilike.%${q}%`)
 */
export function sanitizeForPostgrestOr(input: string): string {
  return input.replace(/[%_,()\\"]/g, '');
}
