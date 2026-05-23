import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import { useReindexRag } from './useReindexRag';
import type { CustomerProcess, StructuredProcessResponse } from '@/lib/customer-process/types';
import type { Json } from '@/integrations/supabase/types';

export function useCustomerProcess(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-process', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async (): Promise<CustomerProcess | null> => {
      if (!customerId) return null;
       
      const { data, error } = await supabase.from('customer_processes')
        .select('*')
        .eq('customer_user_id', customerId)
        .eq('is_current', true)
        .maybeSingle();
      if (error) throw error;
      // etapas vem como Json do banco; CustomerProcess.etapas é ProcessEtapa[].
      // Cast via unknown (mesmo padrão da linha do insert) — tipos não se sobrepõem.
      return (data as unknown as CustomerProcess) ?? null;
    },
  });
}

interface SaveInput {
  customerId: string;
  descricao_livre: string;
  structured?: StructuredProcessResponse;
  previousId?: string;
}

export function useSaveCustomerProcess() {
  const qc = useQueryClient();
  const reindex = useReindexRag();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<CustomerProcess> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      // Se já existe um current, marca como não-current primeiro
      if (input.previousId) {
         
        await supabase.from('customer_processes')
          .update({ is_current: false })
          .eq('id', input.previousId);
      }

      const payload = {
        customer_user_id: input.customerId,
        descricao_livre: input.descricao_livre,
        etapas: (input.structured?.etapas ?? null) as unknown as Json,
        segmento: input.structured?.segmento ?? null,
        porte: input.structured?.porte ?? null,
        tags: input.structured?.tags ?? [],
        ia_confidence: input.structured?.ia_confidence ?? null,
        ia_gaps: input.structured?.ia_gaps ?? [],
        ia_structured_at: input.structured ? new Date().toISOString() : null,
        is_current: true,
        created_by: user.id,
        parent_id: input.previousId ?? null,
      };

       
      const { data, error } = await supabase.from('customer_processes')
        .insert(payload)
        .select()
        .single();

      if (error) throw error;
      return data as unknown as CustomerProcess;
    },
    onSuccess: (data, variables) => {
      qc.invalidateQueries({ queryKey: ['customer-process', variables.customerId] });
      toast.success('Processo salvo');
      // Fire-and-forget reindex pra RAG ficar atualizado pro PR-P3/P4
      reindex.mutate({ source_table: 'customer_processes', source_id: data.id });
    },
    onError: (err) => {
      toast.error('Erro ao salvar processo', { description: err instanceof Error ? err.message : '' });
    },
  });
}

export function useStructureProcess() {
  return useMutation({
    mutationFn: async (descricao_livre: string): Promise<StructuredProcessResponse> => {
      const response = await invokeFunction<{ structured: StructuredProcessResponse }>(
        'structure-customer-process',
        { descricao_livre }
      );
      return response.structured;
    },
    onError: (err) => {
      toast.error('Erro na estruturação', { description: err instanceof Error ? err.message : '' });
    },
  });
}
