import { useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import type { OmieCustomer, Product } from '@/hooks/useUnifiedOrder';

/* ─── Deep-link query param keys ─── */
const PARAM_KEYS = {
  customer: 'customer',
  product: 'product',
  // Future extensions:
  // tool: 'tool',
  // serviceType: 'serviceType',
} as const;

export interface DeepLinkParams {
  customerId: string | null;
  productId: string | null;
  // Future:
  // toolId: string | null;
  // serviceType: string | null;
}

/**
 * Reads deep-link query params once and drives automatic
 * customer selection + product addition in the unified order flow.
 */
export function useOrderDeepLink({
  selectedCustomer,
  selectCustomer,
  addProductToCart,
  obenProducts,
  colacorProducts,
  loadingObenProducts,
  loadingColacorProducts,
  loadingCustomer,
}: {
  selectedCustomer: OmieCustomer | null;
  selectCustomer: (c: OmieCustomer) => void;
  addProductToCart: (p: Product) => void;
  obenProducts: Product[];
  colacorProducts: Product[];
  loadingObenProducts: boolean;
  loadingColacorProducts: boolean;
  loadingCustomer: boolean;
}) {
  const [searchParams] = useSearchParams();

  const params = useMemo<DeepLinkParams>(() => ({
    customerId: searchParams.get(PARAM_KEYS.customer) || null,
    productId: searchParams.get(PARAM_KEYS.product) || null,
  }), [searchParams]);

  const customerHandled = useRef(false);
  const productHandled = useRef(false);

  /* ── Auto-select customer ── */
  useEffect(() => {
    if (!params.customerId || customerHandled.current || selectedCustomer) return;
    customerHandled.current = true;

    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_clientes', search: params.customerId },
        });
        if (error || !data?.clientes?.length) {
          logger.warn('DeepLink: customer not found', {
            stage: 'resolve_order',
            customerIdParam: params.customerId,
            error,
          });
          return;
        }

        // Try exact codigo_cliente match first, then take first result
        const clientes = data.clientes as OmieCustomer[];
        const exact = clientes.find(
          c => String(c.codigo_cliente) === params.customerId
            || c.cnpj_cpf?.replace(/\D/g, '') === params.customerId?.replace(/\D/g, ''),
        );
        selectCustomer(exact || clientes[0]);
      } catch (err) {
        logger.warn('DeepLink: error fetching customer', {
          stage: 'resolve_order',
          customerIdParam: params.customerId,
          error: err,
        });
      }
    })();
  }, [params.customerId, selectedCustomer, selectCustomer]);

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
