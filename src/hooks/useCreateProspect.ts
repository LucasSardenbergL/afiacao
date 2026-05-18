import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';

export interface CreateProspectInput {
  razao_social: string;
  phone: string;
  nome_contato?: string;
  email?: string;
  cnpj?: string;
  segmento?: string;
  tags?: string[];
  origin_call_id?: string;
  source?: 'chamada_inbound' | 'chamada_outbound' | 'walk_in' | 'manual';
}

export interface CreateProspectResponse {
  ok: boolean;
  user_id: string;
  profile: {
    user_id: string;
    razao_social: string;
    phone: string;
    is_prospect: boolean;
  };
}

/**
 * Cria prospect (cliente novo cadastrado pelo vendedor). Edge fn usa service
 * role pra criar auth.users dummy + profile com is_prospect=true. Se passar
 * origin_call_id, retroativa farmer_calls.customer_user_id.
 *
 * Quando cliente real fizer signup no futuro (se você abrir app pra clientes),
 * basta flipar is_prospect=false e setar email/password real.
 */
export function useCreateProspect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProspectInput): Promise<CreateProspectResponse> => {
      return await invokeFunction<CreateProspectResponse>('create-prospect-customer', input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['farmer-pending-link'] });
      qc.invalidateQueries({ queryKey: ['prospects'] });
      qc.invalidateQueries({ queryKey: ['customer-list'] });
      toast.success('Cliente cadastrado como prospect');
    },
    onError: (err) =>
      toast.error('Erro ao criar prospect', {
        description: err instanceof Error ? err.message : '',
      }),
  });
}
