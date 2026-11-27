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
       
      // Onda D: leitura pela view (só staff, só cliente com contato visível); escrita segue na tabela.
      const { data, error } = await supabase.from('v_cliente_contatos')
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

/** Contato já salvo; se a troca do principal falhar, o erro diz isso (o contato NÃO se perde). */
async function definirPrincipal(contatoId: string): Promise<void> {
  const { error } = await supabase.rpc('contato_cliente_definir_principal', { p_contato_id: contatoId });
  if (error) throw new Error(`Contato salvo, mas não foi marcado como principal: ${error.message}`);
}

export function useSaveContact() {
  const qc = useQueryClient();
  return useMutation({
    // Onda D fatia 4a: a releitura pós-escrita pede só a chave — o contato (telefone, e-mail, nota)
    // fecha a authenticated na tabela (20261126170000) e a lista relê pela `v_cliente_contatos`.
    mutationFn: async (input: SaveInput): Promise<Pick<CustomerContact, 'id' | 'customer_user_id'>> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      // Onda D 4b-2: "principal" não vai mais por 2 UPDATEs soltos (desligar todos do dono informado pelo
      // browser, depois gravar). O contato é salvo SEM mexer no principal e a RPC atômica
      // `contato_cliente_definir_principal` troca o principal do dono DA LINHA numa transação.
      const quer_principal = input.is_primary ?? false;

      const payload = {
        customer_user_id: input.customer_user_id,
        phone: input.phone.replace(/\s+/g, ' ').trim(),
        nome: input.nome ?? null,
        cargo: input.cargo ?? null,
        email: input.email ?? null,
        is_decision_maker: input.is_decision_maker ?? false,
        // Novo contato nasce não-principal; a RPC liga depois (o UNIQUE parcial recusaria 2 principais).
        is_primary: false,
        whatsapp_only: input.whatsapp_only ?? false,
        birthday: input.birthday ?? null,
        notas: input.notas ?? null,
        source: input.source ?? 'manual',
        created_by: user.id,
      };

      if (input.id) {
        // O dono do contato e quem o criou são imutáveis na edição (grant de coluna de UPDATE, 20261126170000):
        // reatribuir um contato para um cliente da carteira o exibiria inteiro pela view.
        // Marcar como principal fica com a RPC; desmarcar grava direto (não troca o principal de ninguém).
        const { customer_user_id: _dono, created_by: _criador, is_primary: _principal, ...resto } = payload;
        const edicao = quer_principal ? resto : { ...resto, is_primary: false };
        const { data, error } = await supabase.from('customer_contacts')
          .update(edicao).eq('id', input.id).select('id, customer_user_id').single();
        if (error) throw error;
        if (quer_principal) await definirPrincipal(data.id);
        return data;
      }

      const { data, error } = await supabase.from('customer_contacts')
        .insert(payload).select('id, customer_user_id').single();
      if (error) throw error;
      if (quer_principal) await definirPrincipal(data.id);
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['customer-contacts', data.customer_user_id] });
      toast.success('Contato salvo');
    },
    onError: (err, input) => {
      // O contato pode ter sido salvo antes de a troca do principal falhar: relê a lista do cliente.
      qc.invalidateQueries({ queryKey: ['customer-contacts', input.customer_user_id] });
      toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' });
    },
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
