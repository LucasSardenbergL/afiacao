import { useAuth, type AppRole } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
import { useCommercialRole, type CommercialRole } from '@/hooks/useCommercialRole';
import { useUserDepartment } from '@/hooks/useUserDepartment';

const GESTOR_COMERCIAL_ROLES = ['gerencial', 'estrategico', 'super_admin'];

export interface DisplayAccess {
  displayRole: AppRole | null;
  displayIsStaff: boolean;
  displayIsMaster: boolean;
  displayIsGestorComercial: boolean;
  displayIsSalesOnly: boolean;
  /** commercial_role CRU (não o booleano): necessário p/ a inferência de persona
   *  distinguir gerencial→gestor de estrategico/super_admin→master. */
  displayCommercialRole: CommercialRole | null;
  displayDepartment: string | null;
  /** true enquanto o perfil do alvo carrega na lente; consumidores mostram loading, não o menu do master. */
  displayLoading: boolean;
}

/**
 * Fonte única de acesso de EXIBIÇÃO/NAVEGAÇÃO. NUNCA usar para decidir escrita ou
 * identidade — para isso, use useAuth() real. Sem lente, espelha o usuário real
 * (role, cargo comercial, departamento, sales-only); na lente, deriva do perfil
 * REAL do alvo (get_user_access_profile_for). A paridade fora da lente é total:
 * todo consumidor que migrar de useAuth/useCommercialRole/useUserDepartment para
 * este hook se comporta igual quando não há lente ativa.
 */
export function useDisplayAccess(): DisplayAccess {
  const { role, isStaff, isMaster, isGestorComercial } = useAuth();
  const { isImpersonating } = useImpersonation();
  const { data: targetProfile, isLoading } = useImpersonatedAccessProfile();
  const realIsSalesOnly = useSalesOnlyRestriction();
  const { commercialRole: realCommercialRole } = useCommercialRole();
  const { department: realDepartment } = useUserDepartment();

  if (!isImpersonating) {
    return {
      displayRole: role,
      displayIsStaff: isStaff,
      displayIsMaster: isMaster,
      displayIsGestorComercial: isGestorComercial,
      displayIsSalesOnly: realIsSalesOnly,
      displayCommercialRole: realCommercialRole,
      displayDepartment: realDepartment,
      displayLoading: false,
    };
  }

  if (isLoading || !targetProfile) {
    return {
      displayRole: null, displayIsStaff: false, displayIsMaster: false,
      displayIsGestorComercial: false, displayIsSalesOnly: false,
      displayCommercialRole: null, displayDepartment: null, displayLoading: true,
    };
  }

  const appRole = targetProfile.appRole;
  return {
    displayRole: appRole,
    displayIsStaff: appRole === 'employee' || appRole === 'master',
    displayIsMaster: appRole === 'master',
    displayIsGestorComercial: GESTOR_COMERCIAL_ROLES.includes(targetProfile.commercialRole ?? ''),
    displayIsSalesOnly: targetProfile.isSalesOnly,
    displayCommercialRole: (targetProfile.commercialRole as CommercialRole | null) ?? null,
    displayDepartment: targetProfile.department,
    displayLoading: false,
  };
}
