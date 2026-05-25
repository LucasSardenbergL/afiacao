import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
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
 */
export function useMyMixGap() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-mixgap', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<MixGap | null> => {
      if (!user) return null;
      // RPC fora dos tipos gerados — cast no boundary (preserva `this` do client).
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('get_meu_mixgap');
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as MixGapResumo;
      return { totalComGap: r.total_com_gap, lista: rankGaps(r.lista ?? []) };
    },
  });
}
