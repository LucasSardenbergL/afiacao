import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type Alerta = {
  id: string;
  company: string;
  tipo: string;
  severidade: 'info' | 'aviso' | 'critico';
  mensagem: string;
  valor: number | null;
  threshold: number | null;
  contexto: Record<string, unknown> | null;
  criado_em: string;
  dismissed_at: string | null;
  dismissed_until: string | null;
};

export function useCashflowAlertas(company: string) {
  return useQuery({
    queryKey: ['fin_alertas', 'ativos', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<Alerta[]> => {
      const { data, error } = await supabase
        .from('fin_alertas')
        .select('*')
        .eq('company', company)
        .is('dismissed_at', null)
        .order('criado_em', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Alerta[];
    },
  });
}

export function useDismissAlerta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; snoozeDays?: number }) => {
      const dismissed_at = new Date().toISOString();
      const dismissed_until = input.snoozeDays
        ? new Date(Date.now() + input.snoozeDays * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { error } = await supabase.from('fin_alertas').update({
        dismissed_at,
        dismissed_until,
        dismissed_by: userId,
      }).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fin_alertas'] }),
  });
}
