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

/** Última ligação REGISTRADA do cliente — com ou sem transcrição (o resumo pré-visita só quer a recência). */
export interface CustomerLastCall {
  started_at: string;
  call_result: string | null;
}

/**
 * `useCustomerCalls` só traz chamadas com transcrição (é a fonte da timeline rica). O "Última
 * ligação" do resumo lia dela e dizia "nenhuma" para quem foi ligado sem transcrição. Aqui: a mais
 * recente de `farmer_calls`, qualquer uma. `null` = nenhuma visível; erro LANÇA (≠ "nenhuma").
 */
export function useCustomerLastCall(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-last-call', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CustomerLastCall | null> => {
      if (!customerId) return null;
      const { data, error } = await supabase
        .from('farmer_calls')
        .select('started_at, call_result')
        .eq('customer_user_id', customerId)
        .order('started_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      // data null SEM error = malformada, não "nenhuma ligação".
      if (data == null) throw new Error('farmer_calls: data null sem error');
      return (data[0] as CustomerLastCall | undefined) ?? null;
    },
  });
}
