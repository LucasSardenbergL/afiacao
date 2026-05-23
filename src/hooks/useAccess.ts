import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { useUserDepartment } from '@/hooks/useUserDepartment';
import { useSalesOnlyState } from '@/hooks/useSalesOnlyRestriction';
import { resolveAccessPersona, resolveGroupTag } from '@/lib/access/resolve-access';
import { canAccess, isReadOnly } from '@/lib/access/access-matrix';
import type { AccessPersona, GroupTag, SectionId } from '@/lib/access/types';

export interface UseAccessReturn {
  persona: AccessPersona;
  group: GroupTag | null;
  loading: boolean;
  can: (section: SectionId) => boolean;
  isReadOnly: (section: SectionId) => boolean;
}

export function useAccess(): UseAccessReturn {
  // Note: useUserDepartment exposes `isLoading` (not `loading`) — adapt accordingly
  const { role, loading: authLoading } = useAuth();
  const { commercialRole, loading: crLoading } = useCommercialRole();
  const { department, isLoading: deptLoading } = useUserDepartment();
  const { isSalesOnly, loading: salesOnlyLoading } = useSalesOnlyState();

  const persona = useMemo(
    () => resolveAccessPersona({ appRole: role, commercialRole, department, isSalesOnly }),
    [role, commercialRole, department, isSalesOnly],
  );
  const group = useMemo(() => resolveGroupTag(commercialRole), [commercialRole]);

  return {
    persona,
    group,
    // fail-closed: espera TAMBÉM o sales-only resolver (senão um sales-only+dept
    // privilegiado escalaria na janela de load — codex review).
    loading: authLoading || crLoading || deptLoading || salesOnlyLoading,
    can: (section) => canAccess(persona, section),
    isReadOnly: (section) => isReadOnly(persona, section),
  };
}
