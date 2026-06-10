import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import { buildExclusionQuery } from './types';
import { paginateAll, rankProducts, filterRanked } from './catalog-helpers';
import type { Product, ProductAccount } from './types';

const PRODUCT_COLUMNS =
  'id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type, metadata, tipo_produto';

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
 * Encapsula o catálogo de produtos (Oben + Colacor):
 * - Carregamento inicial via Supabase (com fallback de sync via edge function)
 * - Sincronização de estoque em background (queue serializada compartilhada
 *   entre as duas contas para não estourar rate limit do Omie)
 * - Filtros + ordenação memoizados (priorizando produtos previamente comprados)
 */
export function useProductCatalog({
  enabled,
  customerPricesOben,
  customerPricesColacor,
  customerPurchaseHistory,
}: UseProductCatalogOptions) {
  const [obenProducts, setObenProducts] = useState<Product[]>([]);
  const [colacorProducts, setColacorProducts] = useState<Product[]>([]);
  const [loadingObenProducts, setLoadingObenProducts] = useState(true);
  const [loadingColacorProducts, setLoadingColacorProducts] = useState(true);
  const [productSearch, setProductSearch] = useState('');

  // Queue compartilhada: ambas as contas usam a mesma chain para evitar rate limit no Omie.
  const stockSyncQueue = useRef<Promise<void>>(Promise.resolve());

  const syncStockInBackground = useCallback(
    (account: ProductAccount, setProds: React.Dispatch<React.SetStateAction<Product[]>>) => {
      stockSyncQueue.current = stockSyncQueue.current.then(async () => {
        try {
          let nextPage: number | null = 1;
          while (nextPage) {
            const result: { data: unknown; error: unknown } = await supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'sync_estoque', start_page: nextPage, account },
            });
            if (result.error) break;
            nextPage = (result.data as { nextPage?: number | null } | null)?.nextPage ?? null;
          }
          const refreshed = await fetchProductsForAccount(account);
          if (refreshed.length > 0) setProds(refreshed);
        } catch (e) {
          logger.error('Background stock sync error', {
            account,
            stage: 'background_stock_sync',
            error: e,
          });
        }
      });
    },
    [],
  );

  const loadProductsForAccount = useCallback(
    async (account: ProductAccount) => {
      const setLoading = account === 'oben' ? setLoadingObenProducts : setLoadingColacorProducts;
      const setProds = account === 'oben' ? setObenProducts : setColacorProducts;
      setLoading(true);
      try {
        let products = await fetchProductsForAccount(account);

        // Catálogo vazio → dispara sync paginado completo via edge function
        if (products.length === 0) {
          try {
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
          } catch (syncErr) {
            logger.error('Catalog sync error (empty catalog fallback)', {
              account,
              stage: 'fallback_sync',
              error: syncErr,
            });
          }
        }

        setProds(products);
        syncStockInBackground(account, setProds);
      } catch (e) {
        logger.error('loadProductsForAccount failed', {
          account,
          stage: 'initial_load',
          error: e,
        });
      } finally {
        setLoading(false);
      }
    },
    [syncStockInBackground],
  );

  // Bootstrap: carrega ambas as contas em paralelo (mas estoque é serializado pela queue).
  useEffect(() => {
    if (!enabled) return;
    loadProductsForAccount('oben');
    loadProductsForAccount('colacor');
  }, [enabled, loadProductsForAccount]);

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
    loadingObenProducts,
    loadingColacorProducts,
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
