import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { rankGaps } from '@/lib/mixgap/format';
import type { MixGapResumo, GapCliente } from '@/lib/mixgap/types';

export interface MixGap {
  totalComGap: number;
  lista: GapCliente[];
}

/**
 * Oportunidades de cross-sell da carteira PRÓPRIA: clientes sem uma família
 * que clientes parecidos compram (regras de associação). Verdade na RPC
 * get_meu_mixgap() (SECURITY DEFINER, auth.uid()); JS só rankeia/formata.
 * Quando impersonando, chama get_meu_mixgap_for(p_target).
 */
export function useMyMixGap() {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  return useQuery({
    queryKey: ['my-mixgap', effectiveUserId],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<MixGap | null> => {
      if (!user) return null;
      const client = supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
      };
      const { data, error } = isImpersonating && effectiveUserId
        ? await client.rpc('get_meu_mixgap_for', { p_target: effectiveUserId })
        : await client.rpc('get_meu_mixgap');
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as MixGapResumo;
      return { totalComGap: r.total_com_gap, lista: rankGaps(r.lista ?? []) };
    },
  });
}
