import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EventoEventual = {
  id: string;
  company: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  data_prevista: string;
  data_realizada: string | null;
  status: 'previsto' | 'confirmado' | 'cancelado' | 'realizado';
  observacao: string | null;
};

export type EventoEventualInput = Omit<EventoEventual, 'id'>;

export function useEventosEventuais(company: string, periodo?: { de: string; ate: string }) {
  return useQuery({
    queryKey: ['fin_eventos_eventuais', company, periodo?.de, periodo?.ate],
    enabled: Boolean(company),
    queryFn: async (): Promise<EventoEventual[]> => {
      // @ts-expect-error - fin_eventos_eventuais não está em types.ts (regenera após migration apply)
      let q = supabase
        .from('fin_eventos_eventuais')
        .select('*')
        .eq('company', company)
        .order('data_prevista');
      if (periodo) {
        q = q.gte('data_prevista', periodo.de).lte('data_prevista', periodo.ate);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as EventoEventual[];
    },
  });
}

export function useCreateEventoEventual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EventoEventualInput) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      // @ts-expect-error - fin_eventos_eventuais não está em types.ts (regenera após migration apply)
      const { data, error } = await supabase
        .from('fin_eventos_eventuais')
        .insert({ ...input, criado_por: userId })
        .select()
        .single();
      if (error) throw error;
      return data as unknown as EventoEventual;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_eventuais'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useUpdateEventoEventual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<EventoEventualInput> }) => {
      // @ts-expect-error - fin_eventos_eventuais não está em types.ts (regenera após migration apply)
      const { error } = await supabase
        .from('fin_eventos_eventuais')
        .update({ ...input.patch, updated_at: new Date().toISOString() })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_eventuais'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useDeleteEventoEventual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // @ts-expect-error - fin_eventos_eventuais não está em types.ts (regenera após migration apply)
      const { error } = await supabase.from('fin_eventos_eventuais').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_eventuais'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}
