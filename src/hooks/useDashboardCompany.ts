import { useMemo } from 'react';
import { ALL_COMPANIES, useCompany, type Company } from '@/contexts/CompanyContext';

type DashboardCompanyMode = 'single' | 'all';

export interface UseDashboardCompanyReturn {
  /** 'single' = filtrar por 1 empresa. 'all' = agregar 3 empresas. */
  mode: DashboardCompanyMode;
  /** Empresas que a zona deve consultar. Em 'all' = todas; em 'single' = [selecionada]. */
  companies: Company[];
  /** Empresa canônica para KPIs que não podem somar (ex: status de fechamento). */
  primary: Company;
}

export function useDashboardCompany(): UseDashboardCompanyReturn {
  const { selection, activeCompany } = useCompany();

  return useMemo(() => {
    if (selection === 'all') {
      return { mode: 'all', companies: ALL_COMPANIES, primary: activeCompany };
    }
    return { mode: 'single', companies: [selection], primary: selection };
  }, [selection, activeCompany]);
}
