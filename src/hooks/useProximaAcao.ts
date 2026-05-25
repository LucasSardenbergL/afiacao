// src/hooks/useProximaAcao.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ProximaAcaoResult } from '@/services/financeiroService';

export function useProximaAcao(enabled = true) {
  return useQuery({
    queryKey: ['fin_proxima_acao'],
    enabled,
    queryFn: async (): Promise<ProximaAcaoResult> => {
      const { data, error } = await supabase.functions.invoke('fin-next-best-action', { body: {} });
      if (error) throw error;
      return data as ProximaAcaoResult;
    },
  });
}
