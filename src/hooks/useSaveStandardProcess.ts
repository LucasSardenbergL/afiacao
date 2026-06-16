import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { slugify } from '@/lib/standard-process/types';
import { useReindexRag } from './useReindexRag';
import type { StandardProcess, StandardProcessEtapa, StandardProcessStatus } from '@/lib/standard-process/types';
import type { Json } from '@/integrations/supabase/types';

interface SaveInput {
  id?: string;  // se passar, UPDATE; senão INSERT
  name: string;
  description?: string;
  segmento: string;
  porte_alvo: string[];
  tags: string[];
  etapas: StandardProcessEtapa[];
  expected_outcomes: string[];
  target_audience?: string;
  prerequisites: string[];
  status: StandardProcessStatus;
}

export function useSaveStandardProcess() {
  const qc = useQueryClient();
  const reindex = useReindexRag();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<StandardProcess> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      const payload = {
        name: input.name,
        slug: slugify(input.name),
        description: input.description ?? null,
        segmento: input.segmento,
        porte_alvo: input.porte_alvo,
        tags: input.tags,
        etapas: input.etapas as unknown as Json,
        expected_outcomes: input.expected_outcomes,
        target_audience: input.target_audience ?? null,
        prerequisites: input.prerequisites,
        status: input.status,
      };

      if (input.id) {
         
        const { data, error } = await supabase.from('standard_processes')
          .update(payload).eq('id', input.id).select().single();
        if (error) throw error;
        return data as unknown as StandardProcess;
      }
       
      const { data, error } = await supabase.from('standard_processes')
        .insert({ ...payload, created_by: user.id }).select().single();
      if (error) throw error;
      return data as unknown as StandardProcess;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['standard-processes'] });
      qc.invalidateQueries({ queryKey: ['standard-process', data.id] });
      toast.success('Processo salvo');
      // Fire-and-forget reindex — edge fn detecta status≠published e remove chunks se for o caso
      reindex.mutate({ source_table: 'standard_processes', source_id: data.id });
    },
    onError: (err) => toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' }),
  });
}
