import { captureException } from '@/lib/analytics';

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

/** Tamanho da página do PostgREST — é também a capa por request (CLAUDE.md §9b). */
export const POSTGREST_PAGE_SIZE = 1000;

/**
 * Lê uma tabela INTEIRA respeitando a capa de 1.000 linhas por request do PostgREST.
 *
 * A capa é SILENCIOSA: a resposta vem truncada, sem erro e sem aviso. Quem carrega um
 * catálogo inteiro para montar um Map (custo, produto, perfil) e não pagina fica com um
 * mapa parcial — e a cauda vira "não encontrado", que no money-path é lido como "sem
 * custo"/"produto inexistente". Já mordeu este repo em `product_costs` (ver o teste
 * "O CORAÇÃO DO FIX" em costCompute) e os edges já paginam por isso
 * (`algorithm-a-audit`, `fin-valor-cockpit`).
 *
 * `buscarPagina` DEVE aplicar um `.order()` estável junto do `.range(de, ate)`: sem
 * ordenação definida o Postgres não garante a mesma sequência entre requests, e a
 * paginação pode repetir ou pular linhas.
 *
 * FALHA DE PÁGINA REJEITA — página perdida ≠ fim da tabela. Paginar cura a capa de 1.000,
 * NÃO a falha no meio: uma página que falha (timeout 57014, RLS, 500) devolve
 * `{ data: null, error }`, e tratar isso como "acabou" devolveria o acumulado parcial como
 * se fosse a tabela inteira — o MESMO defeito de leitura parcial silenciosa que este helper
 * existe pra evitar, reintroduzido por outra via. Um farmer de 3.858 clientes que perde a 3ª
 * página fica com 2.000, indistinguível de uma carteira que de fato tem 2.000; nos callers de
 * `product_costs` a página perdida vira "SKU sem custo", que INFLA margem. Por isso o `error`
 * é OBRIGATÓRIO no contrato: sem ele o caller não tem como detectar (era o furo original).
 * Fim legítimo da tabela é `data: []` sem erro — só isso encerra o loop.
 *
 * `fonte` rotula a origem na telemetria (ex.: `'product_costs/bundle'`). Opcional para não
 * quebrar caller existente, mas SEMPRE preencha: sem ela a agregação depende do stack trace,
 * que muda com o bundler. Ela é o que separa "product_costs falha às terças" de "algo falhou".
 *
 * ```ts
 * const custos = await fetchAllPages<CostRow>(
 *   (de, ate) =>
 *     supabase.from('product_costs').select('product_id, cost_final')
 *       .order('product_id', { ascending: true }).range(de, ate) as unknown as
 *         PromiseLike<{ data: CostRow[] | null; error: unknown }>,
 *   'product_costs/exemplo',
 * );
 * ```
 */
export async function fetchAllPages<T>(
  buscarPagina: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  fonte = 'nao-informada',
): Promise<T[]> {
  const todas: T[] = [];
  for (let pagina = 0; ; pagina++) {
    const de = pagina * POSTGREST_PAGE_SIZE;
    const ate = (pagina + 1) * POSTGREST_PAGE_SIZE - 1;
    const { data, error } = await buscarPagina(de, ate);
    // Falhar alto é a única leitura honesta: o caller escolhe o fallback, mas não pode ser
    // enganado por um total plausível. `data: null` sem `error` é resposta malformada — o
    // único sinal legítimo de fim é `data: []`.
    if (error != null) {
      relatarPaginaPerdida(fonte, pagina, todas.length, error);
      throw comCausa(`fetchAllPages: página ${pagina} (${de}-${ate}) falhou`, error);
    }
    if (data == null) {
      relatarPaginaPerdida(fonte, pagina, todas.length, null);
      throw comCausa(`fetchAllPages: página ${pagina} (${de}-${ate}) devolveu data null sem error`, error);
    }
    todas.push(...data);
    if (data.length < POSTGREST_PAGE_SIZE) return todas;
  }
}

/**
 * `new Error(msg, { cause })` é ES2022 e o projeto compila com `lib: ES2020` — atribuir a
 * propriedade preserva a causa (o erro original do PostgREST: code/message) sem mexer no
 * target global. Sem ela o incidente chega como "deu erro", sem dizer QUAL fatia sumiu.
 */
function comCausa(mensagem: string, causa: unknown): Error {
  const erro = new Error(mensagem) as Error & { cause?: unknown };
  erro.cause = causa;
  return erro;
}

/**
 * Reporta a página perdida ANTES de lançar. Lançar conserta a mentira do número; sem
 * instrumentar, a falha continua invisível para MEDIÇÃO — e não dá para saber se acontece uma
 * vez por mês ou toda tarde, nem se um caller sofre mais que os outros. Antes do contrato de
 * rejeição isso era impossível por construção: a falha virava lista vazia e ninguém sabia.
 *
 * Só METADADO. As linhas lidas nunca entram no contexto: `linhas_perdidas` é uma CONTAGEM, e
 * o `code`/`message` do PostgREST são de transporte (`57014`, `42501`, "permission denied for
 * table X") — sem payload, sem PII. O caller que quiser tratar o erro ainda recebe a exceção.
 *
 * ⚠️ AO LER A MÉTRICA: um evento por TENTATIVA, não por incidente. Os callers em react-query
 * herdam `retry: 2` (App.tsx), então uma única falha do ponto de vista do usuário emite até
 * 3 eventos. Para "quantas vezes alguém viu a tela quebrar", divida — ou agregue por sessão.
 * Contar tentativas é o que se pode afirmar aqui dentro: o helper não sabe se está numa
 * retentativa (nem deveria — inferir isso seria estado escondido no lugar errado).
 */
function relatarPaginaPerdida(fonte: string, pagina: number, acumuladas: number, causa: unknown): void {
  const pg = causa as { message?: unknown; code?: unknown } | null;
  const message = typeof pg?.message === 'string' ? pg.message : null;
  const code = typeof pg?.code === 'string' ? pg.code : null;
  captureException(new Error(`fetchAllPages(${fonte}): página ${pagina} perdida`), {
    fonte,
    pagina,
    linhas_perdidas: acumuladas,
    codigo: code,
    mensagem: message ?? (causa == null ? 'data=null sem error' : null),
  });
}
