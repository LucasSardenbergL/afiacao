import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
import { useUserDepartment } from '@/hooks/useUserDepartment';
import { getRouteCounts } from '@/lib/dashboard/route-tracker';
import { inferPersona, type InferPersonaResult } from '@/lib/dashboard/persona-detect';
import type { Persona } from '@/lib/dashboard/persona-config';

const STORAGE_KEY = 'dashboardPersonaOverride';

function readOverride(): Persona | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (raw as Persona) : null;
}

/**
 * Resolve persona combinando todos os sinais. Lê override do localStorage diretamente
 * pra evitar dependência circular com DashboardPersonaContext (que envolve em volta).
 * O Context expõe setOverride/clearOverride pra UI.
 */
export function usePersona(): InferPersonaResult {
  const { role } = useAuth();
  const { commercialRole } = useCommercialRole();
  const isSalesOnly = useSalesOnlyRestriction();
  const { department } = useUserDepartment();

  return useMemo(() => {
    return inferPersona({
      override: readOverride(),
      role,
      commercialRole,
      isSalesOnly,
      routeCounts: getRouteCounts(),
      userDepartment: department,
    });
  }, [role, commercialRole, isSalesOnly, department]);
}
