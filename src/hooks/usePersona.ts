import { useMemo } from 'react';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { getRouteCounts } from '@/lib/dashboard/route-tracker';
import { inferPersona, type InferPersonaResult } from '@/lib/dashboard/persona-detect';
import type { Persona } from '@/lib/dashboard/persona-config';
import type { CommercialRole } from '@/hooks/useCommercialRole';
import type { Department } from '@/integrations/supabase/types-departments';

/**
 * Resolve a persona do dashboard. Na lente, usa o acesso de EXIBIÇÃO do alvo
 * (display*), então a ordem dos cards reflete o alvo. Fora da lente, os display*
 * são os reais. O override manual continua sendo a fonte de verdade quando setado.
 */
export function usePersona(override: Persona | null): InferPersonaResult {
  const { displayRole, displayIsSalesOnly, displayIsGestorComercial, displayDepartment } = useDisplayAccess();

  return useMemo(() => {
    // O display só informa "é gestor comercial?"; mapeamos gestor->'gerencial' e
    // não-gestor->null (cai em department/heurística/default). Suficiente para a
    // ordem de cards; o displayDepartment direciona a persona antes da heurística.
    const commercialRole: CommercialRole | null = displayIsGestorComercial ? 'gerencial' : null;
    return inferPersona({
      override,
      role: displayRole,
      commercialRole,
      isSalesOnly: displayIsSalesOnly,
      routeCounts: getRouteCounts(),
      userDepartment: (displayDepartment as Department | null) ?? null,
    });
  }, [override, displayRole, displayIsSalesOnly, displayIsGestorComercial, displayDepartment]);
}
