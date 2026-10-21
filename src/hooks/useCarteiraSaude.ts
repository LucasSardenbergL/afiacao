import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { carteiraSaudeDoJson } from '@/lib/carteira-saude/borda';
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
      const { data, error } = await supabase.rpc('get_carteira_saude');
      if (error) throw new Error(error.message);
      return carteiraSaudeDoJson(data);
    },
  });
}
