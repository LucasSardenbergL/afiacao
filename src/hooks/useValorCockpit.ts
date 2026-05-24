// src/hooks/useValorCockpit.ts
// A3 — Cockpit de Valor: hook react-query que invoca a edge function fin-valor-cockpit.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ValorCockpitResult } from '@/services/financeiroService';

export function useValorCockpit() {
  return useQuery({
    queryKey: ['fin_valor_cockpit', 'oben'],
    queryFn: async (): Promise<ValorCockpitResult> => {
      const { data, error } = await supabase.functions.invoke('fin-valor-cockpit', { body: {} });
      if (error) throw error;
      return data as ValorCockpitResult;
    },
  });
}
