import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { CustomerContact, ContactCargo } from '@/lib/customer-contact/types';

export function useCustomerContacts(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-contacts', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async (): Promise<CustomerContact[]> => {
      if (!customerId) return [];
       
      const { data, error } = await supabase.from('customer_contacts')
        .select('*')
        .eq('customer_user_id', customerId)
        .order('is_primary', { ascending: false })
        .order('nome', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CustomerContact[];
    },
  });
}

interface SaveInput {
  id?: string;
  customer_user_id: string;
  phone: string;
  nome?: string;
  cargo?: ContactCargo;
  email?: string;
  is_decision_maker?: boolean;
  is_primary?: boolean;
  whatsapp_only?: boolean;
  birthday?: string | null;
  notas?: string;
  source?: 'manual' | 'omie' | 'auto_detected_call' | 'auto_import';
}

export function useSaveContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<CustomerContact> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      // Se setar is_primary=true, desliga primary de outros do mesmo cliente primeiro
      if (input.is_primary) {
         
        await supabase.from('customer_contacts')
          .update({ is_primary: false })
          .eq('customer_user_id', input.customer_user_id);
      }

      const payload = {
        customer_user_id: input.customer_user_id,
        phone: input.phone.replace(/\s+/g, ' ').trim(),
        nome: input.nome ?? null,
        cargo: input.cargo ?? null,
        email: input.email ?? null,
        is_decision_maker: input.is_decision_maker ?? false,
        is_primary: input.is_primary ?? false,
        whatsapp_only: input.whatsapp_only ?? false,
        birthday: input.birthday ?? null,
        notas: input.notas ?? null,
        source: input.source ?? 'manual',
        created_by: user.id,
      };

      if (input.id) {
         
        const { data, error } = await supabase.from('customer_contacts')
          .update(payload).eq('id', input.id).select().single();
        if (error) throw error;
        return data as CustomerContact;
      }

       
      const { data, error } = await supabase.from('customer_contacts')
        .insert(payload).select().single();
      if (error) throw error;
      return data as CustomerContact;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['customer-contacts', data.customer_user_id] });
      toast.success('Contato salvo');
    },
    onError: (err) => toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' }),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, customerId }: { id: string; customerId: string }) => {
       
      const { error } = await supabase.from('customer_contacts').delete().eq('id', id);
      if (error) throw error;
      return customerId;
    },
    onSuccess: (customerId) => {
      qc.invalidateQueries({ queryKey: ['customer-contacts', customerId] });
      toast.success('Contato removido');
    },
    onError: (err) => toast.error('Erro ao remover', { description: err instanceof Error ? err.message : '' }),
  });
}
