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
 * Filtra + ordena o catálogo para exibição/busca. Função pura (extraída do
 * `buildFilteredList` do `useProductCatalog`) para ser testável e garantir que a
 * busca varre a lista COMPLETA — não uma fatia capada.
 *
 * Ordenação: comprado-antes (se priorizar) → ativo → alfabético por descrição →
 * desempate determinístico por `id` (evita ordem instável entre descrições iguais).
 * Busca (quando há termo): substring case-insensitive em `descricao`, `codigo` e
 * no `omie_codigo_produto` (cobre quem digita o código interno do Omie).
 */
export function filterAndRankProducts(
  products: Product[],
  term: string,
  ctx: RankContext,
  limit = 50,
): Product[] {
  const sorted = [...products].sort((a, b) => {
    if (ctx.shouldPrioritize) {
      const aPrev = ctx.isPreviouslyPurchased(a);
      const bPrev = ctx.isPreviouslyPurchased(b);
      if (aPrev && !bPrev) return -1;
      if (!aPrev && bPrev) return 1;
    }
    if (a.ativo && !b.ativo) return -1;
    if (!a.ativo && b.ativo) return 1;
    const byDesc = a.descricao.localeCompare(b.descricao);
    if (byDesc !== 0) return byDesc;
    return a.id.localeCompare(b.id);
  });

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
