import type { Product } from './types';

/**
 * Pagina uma fonte até esgotá-la, contornando o cap default do PostgREST (1000
 * linhas por request). `fetchPage(from, to)` recebe o range INCLUSIVO de cada
 * página (compatível com `.range()` do supabase-js). Para quando uma página vem
 * com menos que `pageSize` (= última página) ou ao atingir `maxPages` (guard
 * defensivo contra loop infinito caso a fonte nunca encolha).
 *
 * Erro em qualquer página PROPAGA (rejeita) — o chamador NÃO deve publicar um
 * catálogo parcial por cima de um bom (senão o cap volta disfarçado de "sumiu").
 */
export async function paginateAll<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000,
  maxPages = 100,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage(from, from + pageSize - 1);
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

export interface RankContext {
  /** True se o produto já foi comprado pelo cliente (preço de contrato ou histórico). */
  isPreviouslyPurchased: (p: Product) => boolean;
  /** Só prioriza "comprado antes" quando há dados de cliente carregados. */
  shouldPrioritize: boolean;
}

/**
 * Ordena o catálogo: comprado-antes (se priorizar) → ativo → alfabético por
 * descrição → desempate determinístico por `id` (evita ordem instável entre
 * descrições iguais). Pura; não muta a entrada.
 *
 * Separada do filtro de propósito: a ordenação só depende do catálogo e do
 * cliente — memoizar o resultado e re-rodar SÓ o filtro por tecla evita
 * re-ordenar ~8k produtos a cada caractere digitado no wizard.
 * Decorate-sort-undecorate: `isPreviouslyPurchased` era chamado 2× POR
 * COMPARAÇÃO (O(n·log n) lookups); aqui é 1× por produto.
 */
export function rankProducts(products: Product[], ctx: RankContext): Product[] {
  const decorated = products.map((p) => ({
    p,
    prev: ctx.shouldPrioritize && ctx.isPreviouslyPurchased(p),
  }));
  decorated.sort((a, b) => {
    if (a.prev && !b.prev) return -1;
    if (!a.prev && b.prev) return 1;
    if (a.p.ativo && !b.p.ativo) return -1;
    if (!a.p.ativo && b.p.ativo) return 1;
    const byDesc = a.p.descricao.localeCompare(b.p.descricao);
    if (byDesc !== 0) return byDesc;
    return a.p.id.localeCompare(b.p.id);
  });
  return decorated.map((d) => d.p);
}

/**
 * Filtra uma lista JÁ ordenada (saída de `rankProducts`) pelo termo de busca.
 * Busca: substring case-insensitive em `descricao`, `codigo` e no
 * `omie_codigo_produto` (cobre quem digita o código interno do Omie).
 * Varre a lista COMPLETA — não uma fatia capada.
 */
export function filterRanked(sorted: Product[], term: string, limit = 50): Product[] {
  if (!term) return sorted.slice(0, limit);
  const q = term.toLowerCase();
  return sorted
    .filter(
      (p) =>
        p.descricao.toLowerCase().includes(q) ||
        p.codigo.toLowerCase().includes(q) ||
        String(p.omie_codigo_produto).includes(q),
    )
    .slice(0, limit);
}

/**
 * Filtra + ordena o catálogo para exibição/busca (composição rank → filter,
 * mantida pela compatibilidade com os testes/consumidores existentes).
 */
export function filterAndRankProducts(
  products: Product[],
  term: string,
  ctx: RankContext,
  limit = 50,
): Product[] {
  return filterRanked(rankProducts(products, ctx), term, limit);
}
