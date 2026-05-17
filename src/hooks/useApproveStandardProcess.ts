import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { StandardProcessStatus } from '@/lib/standard-process/types';

interface Input {
  id: string;
  status: StandardProcessStatus;
  notes?: string;
}

export function useApproveStandardProcess() {
  const qc = useQueryClient();
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('standard_processes') as any)
        .update(payload).eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_, { status }) => {
      qc.invalidateQueries({ queryKey: ['standard-processes'] });
      const label: Record<StandardProcessStatus, string> = {
        draft: 'Voltado pra rascunho',
        in_review: 'Enviado pra revisão',
        published: 'Publicado',
        archived: 'Arquivado',
      };
      toast.success(label[status]);
    },
    onError: (err) => toast.error('Erro ao atualizar status', { description: err instanceof Error ? err.message : '' }),
  });
}
