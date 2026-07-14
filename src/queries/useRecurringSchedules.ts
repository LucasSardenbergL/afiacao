import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface RecurringScheduleSummary {
  id: string;
  frequency_days: number;
  next_order_date: string;
}

/**
 * Agendamentos recorrentes ATIVOS do cliente, próximo primeiro. Só-leitura, para
 * o resumo da Central — a página RecurringSchedules segue dona do CRUD (create/
 * toggle/delete imperativos, SEM react-query). Como não há invalidação cruzada,
 * `refetchOnMount: 'always'` revalida ao abrir a Central para não exibir um
 * agendamento obsoleto (criado/pausado/removido na outra tela). Não escreve nada.
 */
export function useActiveRecurringSchedules(userId: string | undefined) {
  return useQuery({
    queryKey: ['recurring-schedules', 'active', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('recurring_schedules')
        .select('id, frequency_days, next_order_date')
        .eq('user_id', userId!)
        .eq('is_active', true)
        .order('next_order_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as RecurringScheduleSummary[];
    },
    enabled: !!userId,
    refetchOnMount: 'always',
  });
}
