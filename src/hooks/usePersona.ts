import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
import { useUserDepartment } from '@/hooks/useUserDepartment';
import { getRouteCounts } from '@/lib/dashboard/route-tracker';
import { inferPersona, type InferPersonaResult } from '@/lib/dashboard/persona-detect';
import type { Persona } from '@/lib/dashboard/persona-config';

/**
 * Resolve persona combinando todos os sinais. O override manual é a única fonte
 * de verdade do DashboardPersonaContext e entra como argumento — listá-lo nas
 * deps do useMemo garante que trocar de persona recomputa a resolução na hora.
 * Por isso o hook é chamado dentro do provider (abaixo do estado de override),
 * não acima dele.
 */
export function usePersona(override: Persona | null): InferPersonaResult {
  const { role } = useAuth();
  const { commercialRole } = useCommercialRole();
  const isSalesOnly = useSalesOnlyRestriction();
  const { department } = useUserDepartment();

  return useMemo(() => {
    return inferPersona({
      override,
      role,
      commercialRole,
      isSalesOnly,
      routeCounts: getRouteCounts(),
      userDepartment: department,
    });
  }, [override, role, commercialRole, isSalesOnly, department]);
}
