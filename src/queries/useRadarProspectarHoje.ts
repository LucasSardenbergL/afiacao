import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { podeProspectarRadar } from '@/lib/nav/acesso-radar';
import { lerProspectarHoje, type ProspectarHoje } from '@/lib/radar/prospectar-hoje';

export const LEADS_DO_CARD = 3;

/**
 * Leads do card "Prospectar hoje" (RPC `radar_prospectar_hoje`, migration 20261106181000). Leitura PURA — está na
 * allowlist de leitura da lente. Sob a lente "Ver como" pede os leads da persona vista (`p_vendedor`); o servidor só
 * aceita isso de gestor. Chave sob `['radar']`: registrar contato/assumir já invalida o prefixo e o lead trabalhado sai.
 */
export function useRadarProspectarHoje(habilitado: boolean) {
  const { role, commercialRole } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const alvo = isImpersonating ? effectiveUserId : null;
  return useQuery({
    queryKey: ['radar', 'prospectar-hoje', alvo ?? 'eu'],
    enabled: habilitado && podeProspectarRadar({ role, commercialRole }),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ProspectarHoje> => {
      const { data, error } = await supabase.rpc('radar_prospectar_hoje', {
        ...(alvo ? { p_vendedor: alvo } : {}),
        p_n: LEADS_DO_CARD,
      });
      if (error) throw error;
      return lerProspectarHoje(data, 'radar_prospectar_hoje');
    },
  });
}
