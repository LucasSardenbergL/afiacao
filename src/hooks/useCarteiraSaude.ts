import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { CarteiraSaudeResumo } from '@/lib/carteira-saude/types';

/**
 * Saúde/observabilidade da carteira (crons, frescor do sync, cobertura de score).
 * RPC SECURITY DEFINER get_carteira_saude() (gate staff via auth.uid()).
 */
export function useCarteiraSaude() {
  const { isStaff } = useAuth();
  return useQuery({
    queryKey: ['carteira-saude'],
    enabled: isStaff,
    staleTime: 60_000,
    queryFn: async (): Promise<CarteiraSaudeResumo | null> => {
      // RPC ainda não nos tipos gerados — cast no boundary (preserva `this` do client).
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('get_carteira_saude');
      if (error) throw new Error(error.message);
      return (data as CarteiraSaudeResumo) ?? null;
    },
  });
}
