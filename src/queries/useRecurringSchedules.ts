import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface RecurringScheduleSummary {
  id: string;
  tool_ids: string[];
  frequency_days: number;
  next_order_date: string;
  is_active: boolean;
}

/**
 * Agendamentos recorrentes ATIVOS do cliente, próximo primeiro. Só-leitura, para
 * o resumo da Central — a página RecurringSchedules segue dona do CRUD (create/
 * toggle/delete imperativos). Não escreve nada aqui.
 */
export function useActiveRecurringSchedules(userId: string | undefined) {
  return useQuery({
    queryKey: ['recurring-schedules', 'active', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('recurring_schedules')
        .select('id, tool_ids, frequency_days, next_order_date, is_active')
        .eq('user_id', userId!)
        .eq('is_active', true)
        .order('next_order_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as RecurringScheduleSummary[];
    },
    enabled: !!userId,
  });
}
