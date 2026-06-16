import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function useLinkCallToCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ callId, customerUserId }: { callId: string; customerUserId: string }) => {
       
      const { error } = await supabase.from('farmer_calls')
        .update({ customer_user_id: customerUserId })
        .eq('id', callId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-calls'] });
      qc.invalidateQueries({ queryKey: ['farmer-pending-link'] });
      toast.success('Chamada vinculada ao cliente');
    },
    onError: (err) => {
      toast.error('Erro ao vincular', { description: err instanceof Error ? err.message : '' });
    },
  });
}
