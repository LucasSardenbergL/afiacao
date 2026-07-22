/**
 * Coleta TODAS as linhas de uma fonte paginada, sem depender de saber o total de antemão.
 *
 * Existe porque `supabase.rpc()` sem paginação é truncado em 1.000 linhas pelo PostgREST — em
 * SILÊNCIO, sem erro e sem sinal no payload. O incidente #1466→#1471 já havia documentado isso em
 * `docs/agent/money-path.md §35`, e mesmo assim a falha se repetiu na edge `calculate-scores`:
 * medido em prod 2026-07-20, `get_customer_sales_summary` devolvia 1.214 clientes e EXATAMENTE
 * 1.000 recebiam refresh — os outros 214 ficavam com `days_since_last_purchase = 999`, gasto 0 e
 * 0 categorias, e apareciam como 'critico' para a vendedora. 50 deles tinham comprado nos últimos
 * 90 dias; 12, na última semana.
 *
 * Duas invariantes que o chamador PRECISA garantir e que esta função não tem como verificar:
 *   1. ORDEM ESTÁVEL E TOTAL. Sem `ORDER BY` determinístico, LIMIT/OFFSET pode repetir e omitir
 *      linhas mesmo somando o total certo. Chave única por linha (ex.: o `GROUP BY` da RPC).
 *   2. A fonte não muda durante a varredura. Para snapshot de cron isso vale; para tabela quente,
 *      preferir cursor/keyset.
 *
 * Função PURA (recebe o buscador por parâmetro) e testável em vitest. Espelhada inline no edge
 * `calculate-scores` como `carregarRpcPaginada`, porque Deno não importa de `src/` — mesma
 * convenção de `salesBase.ts` e `seedTargets.ts`.
 */

export interface PaginaResultado<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Busca o intervalo FECHADO [de, ate] — a mesma semântica do `.range()` do supabase-js. */
export type BuscarPagina<T> = (de: number, ate: number) => Promise<PaginaResultado<T>>;

export interface OpcoesPaginacao {
  /** Linhas por página. Igual à capa do PostgREST, para gastar o mínimo de requisições. */
  tamanhoPagina?: number;
  /**
   * Teto de páginas. Não é otimização: é backstop contra loop infinito se a fonte passar a
   * devolver sempre página cheia (visão recursiva errada, cartesiano). Falhar alto é melhor que
   * consumir a memória do worker até o kill.
   */
  maxPaginas?: number;
  /** Nome da fonte, só para a mensagem de erro ficar diagnosticável. */
  rotulo?: string;
}

export async function coletarPaginado<T>(
  buscar: BuscarPagina<T>,
  opts: OpcoesPaginacao = {},
): Promise<T[]> {
  const tamanhoPagina = opts.tamanhoPagina ?? 1000;
  const maxPaginas = opts.maxPaginas ?? 100;
  const rotulo = opts.rotulo ?? 'fonte paginada';

  if (tamanhoPagina < 1) throw new Error(`${rotulo}: tamanhoPagina precisa ser >= 1`);

  const linhas: T[] = [];
  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const { data, error } = await buscar(pagina * tamanhoPagina, (pagina + 1) * tamanhoPagina - 1);
    if (error) throw new Error(`${rotulo} pág.${pagina}: ${error.message}`);

    const lote = data ?? [];
    linhas.push(...lote);

    // Página incompleta = acabou. Página cheia é ambígua (pode ser a última exata), então pedimos
    // mais uma: uma requisição a mais é barato perto de truncar a base em silêncio.
    if (lote.length < tamanhoPagina) return linhas;
  }

  throw new Error(
    `${rotulo}: mais de ${maxPaginas * tamanhoPagina} linhas — abortado por segurança ` +
    `(possível ordem instável ou junção cartesiana na fonte)`,
  );
}
