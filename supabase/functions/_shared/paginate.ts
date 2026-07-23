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

export interface RespostaPostgrest<T> {
  data: T[] | null;
  count?: number | null;
  error: { message: string } | null;
}

export interface QueryPostgrest<T> extends PromiseLike<RespostaPostgrest<T>> {
  select(colunas: string, opts?: { count?: "exact"; head?: boolean }): QueryPostgrest<T>;
  eq(coluna: string, valor: unknown): QueryPostgrest<T>;
  in(coluna: string, valores: readonly unknown[]): QueryPostgrest<T>;
  gte(coluna: string, valor: unknown): QueryPostgrest<T>;
  lt(coluna: string, valor: unknown): QueryPostgrest<T>;
  not(coluna: string, operador: string, valor: unknown): QueryPostgrest<T>;
  order(coluna: string, opts?: { ascending?: boolean }): QueryPostgrest<T>;
  range(de: number, ate: number): QueryPostgrest<T>;
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
