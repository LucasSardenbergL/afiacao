import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerPainelEmailSemanal, type ModoEmail, type PainelEmailSemanal } from '@/lib/radar/email-semanal';

const CHAVE = ['radar', 'email-semanal', 'painel'] as const;

/**
 * Painel do e-mail semanal do Radar (RPC `radar_email_semanal_painel`, migration 20261107140001). Leitura PURA,
 * na allowlist de leitura da lente. O servidor só responde a master (42501 para o resto).
 */
export function useRadarEmailSemanalPainel(habilitado: boolean) {
  return useQuery({
    queryKey: CHAVE,
    enabled: habilitado,
    queryFn: async (): Promise<PainelEmailSemanal> => {
      const { data, error } = await supabase.rpc('radar_email_semanal_painel');
      if (error) throw error;
      return lerPainelEmailSemanal(data, 'radar_email_semanal_painel');
    },
  });
}

/** Liga/desliga o e-mail de UMA pessoa. Estado no próprio registro (config) + 1 linha no ledger, server-side. */
export function useDefinirEmailSemanal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { userId: string; modo: ModoEmail }) => {
      const { error } = await supabase.rpc('radar_email_semanal_definir', { p_usuario: v.userId, p_modo: v.modo });
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

/** Liga/desliga o envio automático (cron de segunda 08:00 BRT). A RPC confere que o job mudou antes de responder. */
export function useCronEmailSemanal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ativo: boolean) => {
      const { error } = await supabase.rpc('radar_email_semanal_cron', { p_ativo: ativo });
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}
