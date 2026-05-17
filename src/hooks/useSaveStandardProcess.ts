import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { slugify } from '@/lib/standard-process/types';
import type { StandardProcess, StandardProcessEtapa, StandardProcessStatus } from '@/lib/standard-process/types';

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
        etapas: input.etapas,
        expected_outcomes: input.expected_outcomes,
        target_audience: input.target_audience ?? null,
        prerequisites: input.prerequisites,
        status: input.status,
      };

      if (input.id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('standard_processes') as any)
          .update(payload).eq('id', input.id).select().single();
        if (error) throw error;
        return data as StandardProcess;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('standard_processes') as any)
        .insert({ ...payload, created_by: user.id }).select().single();
      if (error) throw error;
      return data as StandardProcess;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['standard-processes'] });
      qc.invalidateQueries({ queryKey: ['standard-process', data.id] });
      toast.success('Processo salvo');
    },
    onError: (err) => toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' }),
  });
}
