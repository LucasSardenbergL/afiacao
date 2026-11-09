import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerExperimento, lerPainelFunil, type ExperimentoFunil, type PainelFunil } from '@/lib/radar/funil';

/**
 * Funil do lead empurrado do Radar (RPC `radar_funil`, migration 20261107233000). Leitura PURA (STABLE), na
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

/**
 * Experimento da coorte do Radar (RPC `radar_funil_experimento`, pacote M, migration 20261111134500): o resultado
 * topo × amostra e a conversão por faixa de nota. Não depende do período; custa ~0,8 s em prod, por isso só lê
 * quando a aba "Uso" está aberta. Mesmo gate e mesma pureza (STABLE) do funil.
 */
export function useRadarFunilExperimento(habilitado: boolean) {
  return useQuery({
    queryKey: ['radar', 'funil-experimento'] as const,
    enabled: habilitado,
    queryFn: async (): Promise<ExperimentoFunil> => {
      const { data, error } = await supabase.rpc('radar_funil_experimento');
      if (error) throw error;
      return lerExperimento(data);
    },
  });
}
