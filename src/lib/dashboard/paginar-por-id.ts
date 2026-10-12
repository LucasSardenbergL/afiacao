/**
 * Laço de paginação por CURSOR de `id` (uuid, ordem total no Postgres), compartilhado pelas leituras de
 * pedidos do dashboard. Cada leitura monta a SUA cadeia de `sales_orders` (é a forma da cadeia que o gate
 * do universo de pedidos julga) e entrega a página; aqui fica só o laço e as travas:
 * erro → lança; `data` nula sem erro → malformada, lança (não é fim); cursor que não avança → lança.
 * Offset seria pior: um pedido que sai do universo entre duas páginas desloca o offset e pula outro.
 */
export const PAGINA_JANELA = 1000;

type Pagina<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function paginarPorId<T extends { id: string }>(
  rotulo: string,
  pagina: (cursor: string | null) => Pagina<T>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const { data, error } = await pagina(cursor);
    if (error) throw new Error(error.message);
    if (data == null) throw new Error(`${rotulo}: data null sem error — malformada, não é fim`);
    out.push(...data);
    if (data.length < PAGINA_JANELA) return out;
    const ultimo = data[data.length - 1].id;
    if (ultimo === cursor) throw new Error(`${rotulo}: cursor não avançou — leitura abortada`);
    cursor = ultimo;
  }
}
