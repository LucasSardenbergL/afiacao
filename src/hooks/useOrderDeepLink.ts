import { useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { logger } from '@/lib/logger';
import type { OmieCustomer, Product } from '@/hooks/useUnifiedOrder';

/* ─── Deep-link query param keys ─── */
const PARAM_KEYS = {
  // O param `customer` é lido pelo selectCustomerByUserId (useUnifiedOrder), não aqui.
  product: 'product',
  // Future extensions:
  // tool: 'tool',
  // serviceType: 'serviceType',
} as const;

export interface DeepLinkParams {
  productId: string | null;
  // Future:
  // toolId: string | null;
  // serviceType: string | null;
}

/**
 * Reads deep-link query params once and drives automatic product addition
 * in the unified order flow. A seleção de cliente a partir de `?customer=<user_id>`
 * é responsabilidade do `selectCustomerByUserId` (useUnifiedOrder) — ver UnifiedOrder.tsx.
 * O ramo de produto só dispara após o cliente estar selecionado.
 */
export function useOrderDeepLink({
  selectedCustomer,
  addProductToCart,
  obenProducts,
  colacorProducts,
  loadingObenProducts,
  loadingColacorProducts,
  loadingCustomer,
}: {
  selectedCustomer: OmieCustomer | null;
  addProductToCart: (p: Product) => void;
  obenProducts: Product[];
  colacorProducts: Product[];
  loadingObenProducts: boolean;
  loadingColacorProducts: boolean;
  loadingCustomer: boolean;
}) {
  const [searchParams] = useSearchParams();

  const params = useMemo<DeepLinkParams>(() => ({
    productId: searchParams.get(PARAM_KEYS.product) || null,
  }), [searchParams]);

  const productHandled = useRef(false);

  /* ── Auto-add product after customer is selected & products loaded ── */
  useEffect(() => {
    if (
      !params.productId
      || productHandled.current
      || !selectedCustomer
      || loadingCustomer
      || (loadingObenProducts && loadingColacorProducts)
    ) return;

    const allProducts = [...obenProducts, ...colacorProducts];
    if (allProducts.length === 0) return;

    productHandled.current = true;

    const product = allProducts.find(
      p => p.id === params.productId
        || p.codigo === params.productId
        || String(p.omie_codigo_produto) === params.productId,
    );

    if (product) {
      addProductToCart(product);
    } else {
      logger.warn('DeepLink: product not found in catalog', {
        stage: 'fallback_to_list',
        productIdParam: params.productId,
        catalogSize: allProducts.length,
      });
    }
  }, [
    params.productId, selectedCustomer, loadingCustomer,
    loadingObenProducts, loadingColacorProducts,
    obenProducts, colacorProducts, addProductToCart,
  ]);

  return params;
}
