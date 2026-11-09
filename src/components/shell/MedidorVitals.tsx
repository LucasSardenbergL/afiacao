import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { iniciarVitals, registrarRotaVitals } from '@/lib/analytics-vitals';

/**
 * Liga o RUM (`app.vitals`) e alimenta a linha do tempo de rotas dele. Monta no
 * `App`, DENTRO do router e FORA do `AppShell` — ao contrário do
 * `PageViewTracker`, o login e as telas públicas também têm LCP a medir.
 */
export function MedidorVitals() {
  const { pathname } = useLocation();

  useEffect(() => {
    iniciarVitals();
  }, []);

  useEffect(() => {
    registrarRotaVitals(pathname);
  }, [pathname]);

  return null;
}
