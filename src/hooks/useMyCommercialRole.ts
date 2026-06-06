import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';

/**
 * Role comercial do "eu efetivo": o user real, ou o ALVO na lente "Ver como".
 * Os 4 novos (farmer/hunter/closer/master) convivem com os legados.
 * Read-only + display-only (escolhe dashboard em /meu-dia; isHunter em FarmerCalls).
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

export function useMyCommercialRole(): { data: MyCommercialRole; isLoading: boolean } {
  const { user } = useAuth();
  const { isImpersonating } = useImpersonation();
  const { data: targetProfile, isLoading: profileLoading } = useImpersonatedAccessProfile();

  // Sem lente: consulta o role do master. Na lente, `enabled:false` evita consultar
  // o role do master (que renderizaria o dashboard ERRADO — o do master).
  const realQuery = useQuery({
    queryKey: ['my-commercial-role', user?.id],
    enabled: !!user && !isImpersonating,
    staleTime: 60_000,
    queryFn: async (): Promise<MyCommercialRole> => {
      if (!user) return null;
      const { data } = await supabase.from('commercial_roles')
        .select('commercial_role')
        .eq('user_id', user.id)
        .maybeSingle();
      return (data?.commercial_role ?? null) as MyCommercialRole;
    },
  });

  // Na lente: role do ALVO. Vem do RPC master-only get_user_access_profile_for, que o
  // useImpersonatedAccessProfile já buscou — sem query nova, sem depender de RLS de
  // commercial_roles cross-user. É o mesmo perfil que alimenta o useDisplayAccess.
  if (isImpersonating) {
    return {
      data: (targetProfile?.commercialRole ?? null) as MyCommercialRole,
      isLoading: profileLoading,
    };
  }
  return { data: realQuery.data ?? null, isLoading: realQuery.isLoading };
}
