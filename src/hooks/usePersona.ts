import { useMemo } from 'react';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { getRouteCounts } from '@/lib/dashboard/route-tracker';
import { inferPersona, type InferPersonaResult } from '@/lib/dashboard/persona-detect';
import type { Persona } from '@/lib/dashboard/persona-config';
import type { Department } from '@/integrations/supabase/types-departments';

/**
 * Resolve a persona do dashboard. Na lente, usa o acesso de EXIBIÇÃO do alvo
 * (display*), então a ordem dos cards reflete o alvo. Fora da lente, os display*
 * são os reais (role, cargo comercial cru, departamento) — paridade total com o
 * comportamento anterior. O override manual continua sendo a fonte quando setado.
 */
export function usePersona(override: Persona | null): InferPersonaResult {
  const { displayRole, displayIsSalesOnly, displayCommercialRole, displayDepartment } = useDisplayAccess();

  return useMemo(() => {
    return inferPersona({
      override,
      role: displayRole,
      commercialRole: displayCommercialRole,
      isSalesOnly: displayIsSalesOnly,
      routeCounts: getRouteCounts(),
      userDepartment: (displayDepartment as Department | null) ?? null,
    });
  }, [override, displayRole, displayIsSalesOnly, displayCommercialRole, displayDepartment]);
}
