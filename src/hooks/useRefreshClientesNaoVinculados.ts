import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';

export function useRefreshClientesNaoVinculados() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ accepted: boolean; already_running?: boolean }> => {
      const { data, error } = await supabase.functions.invoke('omie-analytics-sync', {
        body: { action: 'start_nao_vinculados', account: 'vendas' },
      });
      if (error) throw error;
      return data as { accepted: boolean; already_running?: boolean };
    },
    onSuccess: () => {
      track('carteira.nao_vinculados_atualizar');
      qc.invalidateQueries({ queryKey: ['clientes-nao-vinculados', 'oben'] });
    },
  });
}
