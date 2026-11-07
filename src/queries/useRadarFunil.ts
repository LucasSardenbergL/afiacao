import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerPainelFunil, type PainelFunil } from '@/lib/radar/funil';

/**
 * Funil do lead empurrado do Radar (RPC `radar_funil`, migration 20261107230000). Leitura PURA (STABLE), na
 * allowlist de leitura da lente; o servidor só responde a master e gestor comercial (42501 para o resto).
 * 1 linha jsonb: sem o teto silencioso de 1.000 linhas do PostgREST. Resposta fora da forma LANÇA (nunca vira 0).
 */
export function useRadarFunil(semanas: number, habilitado: boolean) {
  return useQuery({
    queryKey: ['radar', 'funil', semanas] as const,
    enabled: habilitado,
    queryFn: async (): Promise<PainelFunil> => {
      const { data, error } = await supabase.rpc('radar_funil', { p_semanas: semanas });
      if (error) throw error;
      return lerPainelFunil(data);
    },
  });
}
