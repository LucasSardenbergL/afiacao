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
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
