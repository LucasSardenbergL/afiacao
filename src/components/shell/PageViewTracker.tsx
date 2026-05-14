import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { pageview } from '@/lib/analytics';

/**
 * Dispara $pageview a cada mudança de rota. Monta no AppShellLayout uma vez.
 *
 * NOTA: ignoramos query params em alguns casos pra reduzir cardinality
 * (ex: ?cor=12345 na busca de fórmulas). Por enquanto envia URL crua
 * — refinar se PostHog mostrar alta cardinality em "Pages".
 */
export function PageViewTracker() {
  const location = useLocation();

  useEffect(() => {
    pageview(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return null;
}
