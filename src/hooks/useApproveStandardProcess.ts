import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useReindexRag } from './useReindexRag';
import type { StandardProcessStatus } from '@/lib/standard-process/types';

interface Input {
  id: string;
  status: StandardProcessStatus;
  notes?: string;
}

export function useApproveStandardProcess() {
  const qc = useQueryClient();
  const reindex = useReindexRag();
  return useMutation({
    mutationFn: async ({ id, status, notes }: Input) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      const payload: Record<string, unknown> = {
        status,
        status_notes: notes ?? null,
      };
      if (status === 'published' || status === 'archived') {
        payload.reviewed_by = user.id;
        payload.reviewed_at = new Date().toISOString();
      }

       
      const { error } = await supabase.from('standard_processes')
        .update(payload).eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_, { id, status }) => {
      qc.invalidateQueries({ queryKey: ['standard-processes'] });
      const label: Record<StandardProcessStatus, string> = {
        draft: 'Voltado pra rascunho',
        in_review: 'Enviado pra revisão',
        published: 'Publicado',
        archived: 'Arquivado',
      };
      toast.success(label[status]);
      // Fire-and-forget reindex — published indexa, outros status removem chunks
      reindex.mutate({ source_table: 'standard_processes', source_id: id });
    },
    onError: (err) => toast.error('Erro ao atualizar status', { description: err instanceof Error ? err.message : '' }),
  });
}
