import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Chamada persistida em farmer_calls com contexto rico (transcript não-null).
 * Subset dos campos relevantes pra UI da timeline + expand.
 */
export interface CustomerCallRow {
  id: string;
  farmer_id: string;
  customer_user_id: string | null;
  phone_dialed: string | null;
  call_backend: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  call_result: string;
  call_type: string;
  revenue_generated: number | null;
  margin_generated: number | null;
  notes: string | null;
  // jsonb cols
  transcript: unknown;
  analyses: unknown;
  entities_extracted: unknown;
}

export function useCustomerCalls(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-calls', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CustomerCallRow[]> => {
      if (!customerId) return [];
      const { data, error } = await supabase
        .from('farmer_calls')
        .select(`
          id, farmer_id, customer_user_id, phone_dialed, call_backend,
          started_at, ended_at, duration_seconds,
          call_result, call_type, revenue_generated, margin_generated, notes,
          transcript, analyses, entities_extracted
        `)
        .eq('customer_user_id', customerId)
        .not('transcript', 'is', null)
        .order('started_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data ?? []) as CustomerCallRow[];
    },
  });
}
