import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';

export interface TargetAccessProfile {
  appRole: 'employee' | 'customer' | 'master' | null;
  commercialRole: string | null;
  department: string | null;
  isSalesOnly: boolean;
}

export function useImpersonatedAccessProfile() {
  const { isImpersonating, target } = useImpersonation();
  return useQuery({
    queryKey: ['impersonated-access-profile', target?.id],
    enabled: isImpersonating && !!target,
    staleTime: 300_000,
    queryFn: async (): Promise<TargetAccessProfile | null> => {
      if (!target) return null;
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('get_user_access_profile_for', { p_target: target.id });
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        appRole: (r.app_role as TargetAccessProfile['appRole']) ?? null,
        commercialRole: (r.commercial_role as string) ?? null,
        department: (r.department as string) ?? null,
        isSalesOnly: !!r.is_sales_only,
      };
    },
  });
}
