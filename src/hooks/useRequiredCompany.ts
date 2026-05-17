import { useCompany, type Company } from '@/contexts/CompanyContext';
import { logger } from '@/lib/logger';

/**
 * Páginas que ainda não suportam modo 'all' usam esse adapter.
 * Devolve sempre uma Company concreta (cai no último single ativo se selection='all').
 * Em dev, loga warning quando o fallback é acionado pra facilitar identificar páginas a migrar.
 */
export function useRequiredCompany(): Company {
  const { selection, activeCompany } = useCompany();

  if (selection === 'all' && import.meta.env.DEV) {
    logger.warn('useRequiredCompany: selection=all, caindo pra activeCompany', { activeCompany });
  }

  return activeCompany;
}
