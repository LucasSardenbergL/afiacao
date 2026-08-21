// Paginação do PostgREST / Supabase Data API.
//
// FOOTGUN (docs/agent/database.md §5; CLAUDE.md → PostgREST): o Data API capa CADA
// resposta em 1000 linhas, em SILÊNCIO — sem erro. Uma leitura `.select()` que
// ultrapasse 1000 linhas devolve só as primeiras 1000 e a cauda some sem aviso.
// Em espelhos/sincronizações isso vira dado stale (o caso que esta função previne).
//
// `fetchAll` lê em páginas de 1000 via `.range()` até a página vir incompleta.
// O call-site DEVE encadear `.order()` numa coluna ESTÁVEL e única no recorte
// (ex.: a PK), senão o `.range()` pode pular/duplicar linhas entre páginas.
const PAGE = 1000;

// ── Contrato mínimo do PostgREST que a paginação usa ────────────────────────
// Estrutural de propósito: o teste satisfaz com um banco de memória que conta chamadas,
// e o `SupabaseClient` real entra por cast no call-site (`as unknown as BancoPostgrest`)
// — a suíte de edge roda com `--no-remote`, então um módulo testável não pode importar
// `npm:@supabase/supabase-js` nem para tipo.
//
// Mora aqui (e não em `relatorio-mensal.ts`, onde nasceu) porque descreve a forma da
// query que `fetchAll` pagina: é contrato de paginação, não do relatório mensal.

// `error` carrega o `code` do PostgREST (opcional) porque `_shared/leitura-critica.ts`
// decide POR CÓDIGO o que tolerar (`42703` coluna ausente) e o que lançar — e as duas
// famílias, paginação e leitura single-shot, convivem na MESMA query encadeada.
export interface RespostaPostgrest<T> {
  data: T[] | null;
  count?: number | null;
  error: { message: string; code?: string | null; details?: string | null; hint?: string | null } | null;
}

export interface QueryPostgrest<T> extends PromiseLike<RespostaPostgrest<T>> {
  select(colunas: string, opts?: { count?: "exact"; head?: boolean }): QueryPostgrest<T>;
  eq(coluna: string, valor: unknown): QueryPostgrest<T>;
  in(coluna: string, valores: readonly unknown[]): QueryPostgrest<T>;
  gte(coluna: string, valor: unknown): QueryPostgrest<T>;
  /**
   * `>` estrito — o avanço do cursor de `fetchAllKeyset`. Estrito e não `gte` porque a
   * chave é ÚNICA no recorte: com `gte` a última linha de cada página voltaria na página
   * seguinte, duplicada.
   */
  gt(coluna: string, valor: unknown): QueryPostgrest<T>;
  lt(coluna: string, valor: unknown): QueryPostgrest<T>;
  not(coluna: string, operador: string, valor: unknown): QueryPostgrest<T>;
  /**
   * `IS` do PostgREST — na prática, o predicado de soft-delete (`.is('deleted_at', null)`).
   * Entrou quando `carregarPedidosDoMes` passou a aplicar as DUAS metades do contrato do
   * universo de pedidos (denylist de status + `deleted_at IS NULL`): faltava a segunda, e
   * o caller é o do snapshot CONGELADO de positivação, onde um pedido apagado vira receita
   * de um mês que ninguém recalcula.
   */
  is(coluna: string, valor: unknown): QueryPostgrest<T>;
  order(coluna: string, opts?: { ascending?: boolean }): QueryPostgrest<T>;
  range(de: number, ate: number): QueryPostgrest<T>;
  // `limit` é a AMOSTRA deliberada (teto de negócio), não a paginação: quem usa `limit`
  // está dizendo "cabe menos e tudo bem". Continua exigindo `.order()` estável, senão a
  // amostra muda a cada execução e o resultado deixa de ser reprodutível.
  limit(n: number): QueryPostgrest<T>;
  // Termina a cadeia devolvendo UMA linha (ou `null`) em vez de array — mesma resposta
  // `{data,error}`, outro formato de `data`.
  maybeSingle(): PromiseLike<{
    data: T | null;
    error: { message: string; code?: string | null; details?: string | null; hint?: string | null } | null;
  }>;
}

export interface BancoPostgrest {
  // Genérico (e não `QueryPostgrest<unknown>`) para o call-site declarar a forma da linha
  // que espera de cada tabela — é o que mantém `fetchAll<T>` tipado ponta a ponta.
  from<T>(tabela: string): QueryPostgrest<T>;
}

export async function fetchAll<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  let from = 0;
  const out: T[] = [];
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    // `data == null` sem `error` é resposta MALFORMADA do PostgREST — não é fim da tabela.
    // O `?? []` de antes a convertia em página vazia → EOF falso → o acumulado PARCIAL
    // voltava como se fosse a tabela inteira (o defeito que fetchAllPages de
    // src/lib/postgrest.ts e buscarTodasPaginas pós-#1564 já rejeitam). Fim LEGÍTIMO é
    // `data: []` — array vazio, que segue adiante e encerra por `length < PAGE`.
    if (data == null) throw new Error(`${label}: data null sem error — resposta malformada, não é fim da tabela`);
    const rows = data;
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Paginação por KEYSET — para leitura que precisa sobreviver a escrita CONCORRENTE.
 *
 * `fetchAll` pagina por OFFSET: N requests independentes, cada um sua própria transação.
 * O `.order()` numa coluna estável resolve a instabilidade de ORDEM numa tabela parada,
 * mas não cria snapshot. Um INSERT antes do offset corrente desloca as páginas seguintes
 * (uma linha pode ser lida DUAS VEZES); um DELETE desloca no outro sentido (uma linha pode
 * ser PULADA).
 *
 * O keyset (`WHERE chave > cursor ORDER BY chave LIMIT n`) elimina a classe inteira do
 * deslocamento por offset. Não dá snapshot transacional — para isso só uma RPC, como o
 * `omie_sync_identity_snapshot` de `omie-vendas-sync` — mas nenhuma linha some ou repete
 * por causa da posição.
 *
 * QUANDO USAR, e não "sempre": o que desloca uma paginação não é o VOLUME de escrita da
 * tabela, é a escrita que atravessa a FRONTEIRA DO RECORTE — INSERT e DELETE sempre
 * atravessam, UPDATE só se tocar a coluna do `.order()` ou do `WHERE`. `product_costs`
 * leva 8,0M de updates e zero deletes: offset basta. `omie_products` leva 86 inserts e
 * zero deletes e ainda assim exige keyset, porque o `.eq('ativo',true)` do leitor é
 * exatamente o que o cron de status reescreve. A medição está em
 * `docs/historico/paginacao-offset-janela.md`; o precedente de deixar offset onde o custo
 * não se paga, em `fin-valor-cockpit/index.ts:490`.
 *
 * CONTRATO: `chave` tem de ser ÚNICA no recorte e o call-site tem de `.order()` por ela
 * — e o `.select()` precisa TRAZER a coluna (o `.range()` não exigia isso). Chave repetida
 * faria `.gt()` pular as empatadas; o caso patológico (cursor que não avança) é detectado
 * aqui e LANÇA, em vez de girar para sempre.
 */
export async function fetchAllKeyset<T, K>(
  build: (
    cursor: K | null,
    limite: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  chave: (linha: T) => K,
  label: string,
): Promise<T[]> {
  let cursor: K | null = null;
  const out: T[] = [];
  for (;;) {
    const { data, error } = await build(cursor, PAGE);
    if (error) throw new Error(`${label}: ${error.message}`);
    // Mesmo fail-closed de `fetchAll`: `data:null` sem `error` é resposta MALFORMADA,
    // não fim da tabela — devolver o acumulado parcial seria a truncagem silenciosa que
    // o #1581 tirou de 24 call-sites.
    if (data == null) {
      throw new Error(`${label}: data null sem error — resposta malformada, não é fim da tabela`);
    }
    const rows = data;
    out.push(...rows);
    if (rows.length < PAGE) break;
    const proximo = chave(rows[rows.length - 1]);
    // Cursor parado = a chave NÃO é única no recorte (o contrato foi violado). Sem esta
    // guarda o laço pediria a mesma página para sempre e a edge morreria no timeout, que
    // é um sintoma que não se parece nem um pouco com a causa.
    if (cursor !== null && proximo === cursor) {
      throw new Error(
        `${label}: cursor não avançou (chave repetida em ${JSON.stringify(proximo)}) — a chave do keyset precisa ser ÚNICA no recorte`,
      );
    }
    cursor = proximo;
  }
  return out;
}
