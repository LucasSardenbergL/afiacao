// src/hooks/useValorCockpit.ts
// A3 — Cockpit de Valor: hook react-query que invoca a edge function fin-valor-cockpit.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ValorCockpitResult } from '@/services/financeiroService';

// `enabled` evita chamar a edge function (que retornaria 403) quando o usuário não é gestor/master.
export function useValorCockpit(enabled = true) {
  return useQuery({
    queryKey: ['fin_valor_cockpit', 'oben'],
    enabled,
    queryFn: async (): Promise<ValorCockpitResult> => {
      const { data, error } = await supabase.functions.invoke('fin-valor-cockpit', { body: {} });
      if (error) throw error;
      return data as ValorCockpitResult;
    },
  });
}
