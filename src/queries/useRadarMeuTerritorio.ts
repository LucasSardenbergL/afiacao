import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { podeProspectarRadar } from '@/lib/nav/acesso-radar';
import { lerTerritorio, type MunicipioTerritorio } from '@/lib/radar/territorio';

/**
 * Território do vendedor (RPC `radar_meu_territorio`, migration 20261107220500) — vira o recorte "Perto dos seus
 * clientes" da fila do /radar (pacote F). Leitura PURA, na allowlist da lente: sob "Ver como" pede o da persona vista
 * (`p_vendedor`; o servidor só aceita de gestor). O território muda devagar (carteira), então fica 10 min em cache.
 */
export function useRadarMeuTerritorio() {
  const { role, commercialRole } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const alvo = isImpersonating ? effectiveUserId : null;
  return useQuery({
    queryKey: ['radar', 'meu-territorio', alvo ?? 'eu'],
    enabled: podeProspectarRadar({ role, commercialRole }),
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<MunicipioTerritorio[]> => {
      // Set-returning: pagina como manda o gate (a capa de 1.000 do PostgREST vale para .rpc()). O teto real é 10 (a
      // privada limita p_top a [1,10]); a ordem é a MESMA da RPC (clientes desc, código), então não reordena nada.
      const { data, error } = await supabase
        .rpc('radar_meu_territorio', { ...(alvo ? { p_vendedor: alvo } : {}), p_top: 3 })
        .order('clientes', { ascending: false })
        .order('municipio_codigo', { ascending: true })
        .range(0, 9);
      if (error) throw error;
      return lerTerritorio(data, 'radar_meu_territorio');
    },
  });
}
