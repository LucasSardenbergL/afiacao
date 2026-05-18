import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Role comercial do user logado. PR-MULTIVENDOR-4-ROLES adiciona os 4 novos
 * (farmer/hunter/closer/master) ao lado dos legados (operacional/gerencial/etc).
 *
 * NB: existe um hook legado `useCommercialRole` com API diferente — mantido por
 * compat com 4 valores antigos. Este hook V2 retorna direct query React Query
 * + suporta todos os 8 valores.
 */
export type MyCommercialRole =
  | 'farmer'
  | 'hunter'
  | 'closer'
  | 'master'
  | 'operacional'
  | 'gerencial'
  | 'estrategico'
  | 'super_admin'
  | null;

export function useMyCommercialRole() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-commercial-role', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<MyCommercialRole> => {
      if (!user) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('commercial_roles') as any)
        .select('commercial_role')
        .eq('user_id', user.id)
        .maybeSingle();
      return (data?.commercial_role ?? null) as MyCommercialRole;
    },
  });
}
