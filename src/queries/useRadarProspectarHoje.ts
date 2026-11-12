import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { podeProspectarRadar } from '@/lib/nav/acesso-radar';
import { lerProspectarHoje, type ProspectarHoje } from '@/lib/radar/prospectar-hoje';
import { useHojeBRT } from '@/lib/radar/useHojeBRT';

const LEADS_DO_CARD = 3;

/**
 * Leads do card "Prospectar hoje" (RPC `radar_prospectar_hoje`, migration 20261106181000). Leitura PURA — está na
 * allowlist de leitura da lente. Sob a lente "Ver como" pede os leads da persona vista (`p_vendedor`); o servidor só
 * aceita isso de gestor. Quem relê: assumir/liberar/atribuir (`useRadarAtendimentos`, que invalida esta chave junto da
 * posse — pacote F) e o staleTime. O lead que o próprio vendedor assumiu SAI da RPC (pacote E); até o refetch o card o
 * mostra "com você" pelo estado local da mutação.
 *
 * Revisão 2026-11-11 (item 6): o DIA BRT entra na chave. A resposta é "o que fazer HOJE" (retornos vencidos, posses
 * de 48 h), mas a chave não tinha o dia: a aba aberta de um dia para o outro seguia com a agenda de ontem até o
 * staleTime. Agora a virada (timer da meia-noite BRT, ou a volta à aba — `useHojeBRT`) troca a chave e relê; e a volta
 * à aba no MESMO dia relê se o dado venceu (`refetchOnWindowFocus`, que o app desliga no global).
 */
export function useRadarProspectarHoje(habilitado: boolean) {
  const { role, commercialRole } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const alvo = isImpersonating ? effectiveUserId : null;
  const hoje = useHojeBRT();
  return useQuery({
    queryKey: ['radar', 'prospectar-hoje', alvo ?? 'eu', hoje],
    enabled: habilitado && podeProspectarRadar({ role, commercialRole }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
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
