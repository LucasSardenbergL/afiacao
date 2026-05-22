import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EventoRecorrente = {
  id: string;
  company: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  is_folha: boolean;
  dia_do_mes: number;
  inicio: string;
  fim: string | null;
  ativo: boolean;
  observacao: string | null;
};

export type EventoRecorrenteInput = Omit<EventoRecorrente, 'id'>;

export function useEventosRecorrentes(company: string) {
  return useQuery({
    queryKey: ['fin_eventos_recorrentes', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<EventoRecorrente[]> => {
      const { data, error } = await supabase
        .from('fin_eventos_recorrentes')
        .select('*')
        .eq('company', company)
        .order('descricao');
      if (error) throw error;
      return (data ?? []) as unknown as EventoRecorrente[];
    },
  });
}

export function useCreateEventoRecorrente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EventoRecorrenteInput) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data, error } = await supabase
        .from('fin_eventos_recorrentes')
        .insert({ ...input, criado_por: userId })
        .select()
        .single();
      if (error) throw error;
      return data as unknown as EventoRecorrente;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_recorrentes'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useUpdateEventoRecorrente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<EventoRecorrenteInput> }) => {
      const { error } = await supabase
        .from('fin_eventos_recorrentes')
        .update({ ...input.patch, updated_at: new Date().toISOString() })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_recorrentes'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useDeleteEventoRecorrente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('fin_eventos_recorrentes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_recorrentes'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}
