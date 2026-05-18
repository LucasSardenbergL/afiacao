import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ActiveOverride = {
  id: string;
  company: string;
  ano: number;
  mes: number;
  opened_at: string;
  expires_at: string;
  justificativa: string;
  acao_planejada: string;
};

export function usePeriodOverride(company: string) {
  const qc = useQueryClient();

  const activeOverride = useQuery<ActiveOverride | null>({
    queryKey: ['fin_period_overrides', 'active', company],
    enabled: Boolean(company),
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_period_overrides')
        .select('*')
        .eq('company', company)
        .is('closed_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as ActiveOverride | null) ?? null;
    },
  });

  const openOverride = useMutation({
    mutationFn: async (input: { ano: number; mes: number; justificativa: string; acao_planejada: string }) => {
      const { data, error } = await supabase.functions.invoke('fin-period-override', {
        body: { company, ...input },
      });
      if (error) throw error;
      return data as { override_id: string; expires_at: string; opened_at: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_period_overrides', 'active', company] });
    },
  });

  return { activeOverride: activeOverride.data ?? null, openOverride };
}
