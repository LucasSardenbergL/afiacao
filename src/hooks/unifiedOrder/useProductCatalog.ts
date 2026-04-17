import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { buildExclusionQuery } from './types';
import type { Product, ProductAccount } from './types';

const PRODUCT_COLUMNS =
  'id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type, metadata';

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
  const baseQuery = supabase
    .from('omie_products')
    .select(PRODUCT_COLUMNS)
    .eq('account', account);
  const { data } = await buildExclusionQuery(baseQuery as any).order('descricao');
  return (data || []) as Product[];
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
            const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'sync_estoque', start_page: nextPage, account },
            });
            if (error) break;
            nextPage = data?.nextPage || null;
          }
          const refreshed = await fetchProductsForAccount(account);
          if (refreshed.length > 0) setProds(refreshed);
        } catch (e) {
          console.error(`Background stock sync error (${account}):`, e);
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
              const { data: syncResult, error: syncError } = await supabase.functions.invoke(
                'omie-vendas-sync',
                { body: { action: 'sync_products', start_page: nextPage, account } },
              );
              if (syncError) throw syncError;
              nextPage = syncResult?.nextPage || null;
            }
            products = await fetchProductsForAccount(account);
          } catch (syncErr) {
            console.error(`Sync error (${account}):`, syncErr);
          }
        }

        setProds(products);
        syncStockInBackground(account, setProds);
      } catch (e) {
        console.error(`loadProductsForAccount(${account}) error:`, e);
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

  /**
   * Constrói lista filtrada/ordenada para uma conta:
   * 1. Previamente comprados primeiro (se houver dados de cliente)
   * 2. Ativos antes de inativos
   * 3. Alfabético
   * 4. Limita a 50 resultados
   */
  const buildFilteredList = useCallback(
    (products: Product[], account: ProductAccount): Product[] => {
      const prices = account === 'oben' ? customerPricesOben : customerPricesColacor;
      const hasCustomerPrices = Object.keys(prices).length > 0;
      const hasPurchaseHistory = Object.keys(customerPurchaseHistory).length > 0;
      const shouldPrioritize = hasCustomerPrices || hasPurchaseHistory;

      const sorted = [...products].sort((a, b) => {
        if (shouldPrioritize) {
          const aPrev = isProductPreviouslyPurchased(a, account);
          const bPrev = isProductPreviouslyPurchased(b, account);
          if (aPrev && !bPrev) return -1;
          if (!aPrev && bPrev) return 1;
        }
        if (a.ativo && !b.ativo) return -1;
        if (!a.ativo && b.ativo) return 1;
        return a.descricao.localeCompare(b.descricao);
      });

      if (!productSearch) return sorted.slice(0, 50);
      const q = productSearch.toLowerCase();
      return sorted
        .filter((p) => p.descricao.toLowerCase().includes(q) || p.codigo.toLowerCase().includes(q))
        .slice(0, 50);
    },
    [
      productSearch,
      customerPricesOben,
      customerPricesColacor,
      customerPurchaseHistory,
      isProductPreviouslyPurchased,
    ],
  );

  const filteredObenProducts = useMemo(
    () => buildFilteredList(obenProducts, 'oben'),
    [buildFilteredList, obenProducts],
  );

  const filteredColacorProducts = useMemo(
    () => buildFilteredList(colacorProducts, 'colacor'),
    [buildFilteredList, colacorProducts],
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
