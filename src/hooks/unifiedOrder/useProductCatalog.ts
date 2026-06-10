import { useState, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import { buildExclusionQuery } from './types';
import { paginateAll, rankProducts, filterRanked } from './catalog-helpers';
import type { Product, ProductAccount } from './types';

const PRODUCT_COLUMNS =
  'id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type, metadata, tipo_produto';

/**
 * Catálogo em cache React Query por 10min: reabrir o wizard dentro da janela
 * = ZERO requests (a versão anterior, useState+useEffect, re-baixava ~8
 * páginas × 2 contas A CADA abertura de /sales/new e ainda disparava o sync
 * de estoque no Omie por mount). O estoque exibido é indicativo — atualizado
 * pelo sync em background abaixo (1×/janela) e pelos crons server-side.
 */
const CATALOG_STALE_MS = 10 * 60_000;
const CATALOG_GC_MS = 30 * 60_000;
/** Janela do sync de estoque por conta: 1× a cada 10min por sessão. */
const STOCK_SYNC_WINDOW_MS = 10 * 60_000;

const catalogKey = (account: ProductAccount) => ['product-catalog', account] as const;

/* Module-level DE PROPÓSITO (sobrevivem a remounts do wizard na mesma sessão):
   a queue serializa o sync de estoque entre as contas (rate limit do Omie) e
   o timestamp por conta impede martelar o sync a cada mount. */
let stockSyncQueue: Promise<void> = Promise.resolve();
const lastStockSyncAt: Partial<Record<ProductAccount, number>> = {};

/** test-only: zera o estado de sessão do sync (queue + janela por conta). */
export function __resetCatalogSessionStateForTests(): void {
  stockSyncQueue = Promise.resolve();
  delete lastStockSyncAt.oben;
  delete lastStockSyncAt.colacor;
}

interface UseProductCatalogOptions {
  /** Só carrega o catálogo quando true (typically `isStaff`). */
  enabled: boolean;
  customerPricesOben: Record<number, number>;
  customerPricesColacor: Record<number, number>;
  customerPurchaseHistory: Record<string, string>;
}

/**
 * Helper: busca produtos de uma conta com os filtros de família já aplicados.
 */
async function fetchProductsForAccount(account: ProductAccount): Promise<Product[]> {
  // Pagina o catálogo inteiro: sem isto o PostgREST devolve só as 1000 primeiras
  // descrições (cap default) e ~65% do catálogo OBEN fica invisível pra venda.
  // `error` é propagado (não engolido) para nunca publicar catálogo parcial.
  return paginateAll(async (from, to) => {
    const baseQuery = supabase
      .from('omie_products')
      .select(PRODUCT_COLUMNS)
      .eq('account', account);
    const { data, error } = await buildExclusionQuery(baseQuery)
      .order('descricao')
      .order('id')
      .range(from, to);
    if (error) throw error;
    return (data || []) as Product[];
  });
}

/**
 * Carga com cold-start: catálogo local vazio → roda o sync paginado completo
 * via edge function e re-busca (1ª vez numa instalação nova). Vazio PÓS-sync
 * LANÇA — não cachear catálogo vazio como sucesso (a query fica em erro e o
 * próximo mount re-tenta, como a versão useState fazia por remount).
 */
async function loadCatalogWithColdStart(account: ProductAccount): Promise<Product[]> {
  let products = await fetchProductsForAccount(account);

  if (products.length === 0) {
    let nextPage: number | null = 1;
    while (nextPage) {
      const syncRes: { data: unknown; error: unknown } = await supabase.functions.invoke(
        'omie-vendas-sync',
        { body: { action: 'sync_products', start_page: nextPage, account } },
      );
      if (syncRes.error) throw syncRes.error;
      nextPage = (syncRes.data as { nextPage?: number | null } | null)?.nextPage ?? null;
    }
    products = await fetchProductsForAccount(account);
    if (products.length === 0) {
      throw new Error(`Catálogo ${account} vazio mesmo após sync de produtos`);
    }
  }

  return products;
}

/**
 * Sincroniza o estoque da conta no Omie em background, no máximo 1× por
 * janela (por sessão), e publica o catálogo re-baixado via `publishFresh`
 * (→ setQueryData — atualiza o cache sem refetch extra dos consumidores).
 */
function scheduleStockSyncOnce(
  account: ProductAccount,
  publishFresh: (products: Product[]) => void,
): void {
  const last = lastStockSyncAt[account] ?? 0;
  if (Date.now() - last < STOCK_SYNC_WINDOW_MS) return;
  // Claim ANTES de entrar na queue: dois mounts concorrentes não duplicam o sync.
  lastStockSyncAt[account] = Date.now();
  stockSyncQueue = stockSyncQueue.then(async () => {
    try {
      let nextPage: number | null = 1;
      while (nextPage) {
        const result: { data: unknown; error: unknown } = await supabase.functions.invoke(
          'omie-vendas-sync',
          { body: { action: 'sync_estoque', start_page: nextPage, account } },
        );
        if (result.error) break;
        nextPage = (result.data as { nextPage?: number | null } | null)?.nextPage ?? null;
      }
      const refreshed = await fetchProductsForAccount(account);
      if (refreshed.length > 0) publishFresh(refreshed);
    } catch (e) {
      // Falhou → libera a janela pra próxima abertura re-tentar.
      lastStockSyncAt[account] = 0;
      logger.error('Background stock sync error', {
        account,
        stage: 'background_stock_sync',
        error: e,
      });
    }
  });
}

/** Referência estável pro estado "sem dados" (não dispara re-rank por identidade). */
const EMPTY_PRODUCTS: Product[] = [];

/**
 * Encapsula o catálogo de produtos (Oben + Colacor):
 * - Carregamento via React Query (cache 10min entre aberturas do wizard) com
 *   fallback de cold-start via edge function
 * - Sincronização de estoque em background (1×/janela; queue serializada
 *   compartilhada entre as duas contas para não estourar rate limit do Omie)
 * - Filtros + ordenação memoizados (priorizando produtos previamente comprados)
 */
export function useProductCatalog({
  enabled,
  customerPricesOben,
  customerPricesColacor,
  customerPurchaseHistory,
}: UseProductCatalogOptions) {
  const queryClient = useQueryClient();
  const [productSearch, setProductSearch] = useState('');

  const obenQuery = useQuery({
    queryKey: catalogKey('oben'),
    queryFn: () => loadCatalogWithColdStart('oben'),
    enabled,
    staleTime: CATALOG_STALE_MS,
    gcTime: CATALOG_GC_MS,
    retry: 1, // o cold-start embute um sync caro — 1 retry basta (mount seguinte re-tenta)
  });

  const colacorQuery = useQuery({
    queryKey: catalogKey('colacor'),
    queryFn: () => loadCatalogWithColdStart('colacor'),
    enabled,
    staleTime: CATALOG_STALE_MS,
    gcTime: CATALOG_GC_MS,
    retry: 1,
  });

  const obenProducts = obenQuery.data ?? EMPTY_PRODUCTS;
  const colacorProducts = colacorQuery.data ?? EMPTY_PRODUCTS;

  // Sync de estoque em background quando o catálogo da conta resolve.
  // A janela (module-level) garante 1×/10min mesmo com N aberturas do wizard.
  useEffect(() => {
    if (!enabled || !obenQuery.isSuccess) return;
    scheduleStockSyncOnce('oben', (fresh) => queryClient.setQueryData(catalogKey('oben'), fresh));
  }, [enabled, obenQuery.isSuccess, queryClient]);

  useEffect(() => {
    if (!enabled || !colacorQuery.isSuccess) return;
    scheduleStockSyncOnce('colacor', (fresh) =>
      queryClient.setQueryData(catalogKey('colacor'), fresh),
    );
  }, [enabled, colacorQuery.isSuccess, queryClient]);

  // Reload manual (exposto p/ edge cases — era o loadProductsForAccount imperativo).
  const loadProductsForAccount = useCallback(
    async (account: ProductAccount) => {
      await queryClient.refetchQueries({ queryKey: catalogKey(account) });
    },
    [queryClient],
  );

  /**
   * Um produto é "previamente comprado" se há preço específico do cliente
   * no Omie OU se aparece no histórico local de compras (em qualquer formato de chave).
   */
  const isProductPreviouslyPurchased = useCallback(
    (product: Product, account: ProductAccount): boolean => {
      const prices = account === 'oben' ? customerPricesOben : customerPricesColacor;
      if (prices[product.omie_codigo_produto]) return true;
      if (customerPurchaseHistory[product.codigo]) return true;
      if (customerPurchaseHistory[`pid:${product.id}`]) return true;
      if (customerPurchaseHistory[`omie:${product.omie_codigo_produto}`]) return true;
      return false;
    },
    [customerPricesOben, customerPricesColacor, customerPurchaseHistory],
  );

  const getProductLastOrderDate = useCallback(
    (product: Product): string | null => {
      const local =
        customerPurchaseHistory[product.codigo] || customerPurchaseHistory[`pid:${product.id}`];
      if (local) return local;
      const omieDate = customerPurchaseHistory[`omie:${product.omie_codigo_produto}`];
      if (omieDate) {
        // Datas Omie vêm em DD/MM/YYYY; normaliza para ISO.
        const parts = omieDate.split('/');
        if (parts.length === 3) {
          return `${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`;
        }
        return omieDate;
      }
      return null;
    },
    [customerPurchaseHistory],
  );

  // Termo DEFERRED: o input responde na hora (controlado por productSearch) e
  // o recálculo da lista roda em prioridade baixa quando o usuário digita rápido.
  const deferredSearch = useDeferredValue(productSearch);

  // Ordenação memoizada POR CATÁLOGO/CLIENTE — o sort não depende do termo de
  // busca. Antes, cada tecla re-ordenava o catálogo COMPLETO (~3,5k OBEN +
  // ~4,2k Colacor, com localeCompare + lookups de "comprado antes" por
  // comparação) dentro dos dois memos de filtro: era o custo dominante da
  // busca do wizard, sentido como tranco no celular do vendedor externo.
  // Com o React Query, refetch que devolve dado igual preserva a referência
  // (structural sharing) → o rank nem re-executa.
  const rankedObenProducts = useMemo(() => {
    const shouldPrioritize =
      Object.keys(customerPricesOben).length > 0 || Object.keys(customerPurchaseHistory).length > 0;
    return rankProducts(obenProducts, {
      isPreviouslyPurchased: (p) => isProductPreviouslyPurchased(p, 'oben'),
      shouldPrioritize,
    });
  }, [obenProducts, customerPricesOben, customerPurchaseHistory, isProductPreviouslyPurchased]);

  const rankedColacorProducts = useMemo(() => {
    const shouldPrioritize =
      Object.keys(customerPricesColacor).length > 0 ||
      Object.keys(customerPurchaseHistory).length > 0;
    return rankProducts(colacorProducts, {
      isPreviouslyPurchased: (p) => isProductPreviouslyPurchased(p, 'colacor'),
      shouldPrioritize,
    });
  }, [colacorProducts, customerPricesColacor, customerPurchaseHistory, isProductPreviouslyPurchased]);

  // Filtro por tecla sobre a lista JÁ ordenada (barato: 1 passada + slice).
  const filteredObenProducts = useMemo(
    () => filterRanked(rankedObenProducts, deferredSearch, 50),
    [rankedObenProducts, deferredSearch],
  );

  const filteredColacorProducts = useMemo(
    () => filterRanked(rankedColacorProducts, deferredSearch, 50),
    [rankedColacorProducts, deferredSearch],
  );

  return {
    // State
    obenProducts,
    colacorProducts,
    // isPending preserva a semântica da versão useState: loading inicia true e,
    // com enabled=false, permanece true (o original nunca chegava ao finally).
    loadingObenProducts: obenQuery.isPending,
    loadingColacorProducts: colacorQuery.isPending,
    productSearch,
    setProductSearch,
    // Derived
    filteredObenProducts,
    filteredColacorProducts,
    // Helpers
    isProductPreviouslyPurchased,
    getProductLastOrderDate,
    // Actions (exposed for edge cases / manual reload)
    loadProductsForAccount,
  };
}
