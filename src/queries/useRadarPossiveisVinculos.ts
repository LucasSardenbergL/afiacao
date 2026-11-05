import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerVinculo, type VinculoCliente } from '@/lib/radar/vinculos';

/**
 * Clientes com vínculo provável ao lead (RPC `radar_possiveis_vinculos`, migration 20261104201756): até 10, já
 * ordenados no servidor (forte antes de média). Pista para o vendedor, nunca classificação: erro de leitura é
 * `isError` (a ficha diz que não conseguiu verificar), não "cliente novo".
 */
export function useRadarPossiveisVinculos(cnpj: string | null) {
  return useQuery({
    queryKey: ['radar', 'possiveis-vinculos', cnpj],
    enabled: !!cnpj,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async (): Promise<VinculoCliente[]> => {
      // A RPC tem LIMIT 10; o range explicita o teto (PostgREST corta em 1.000 em silêncio).
      const { data, error } = await supabase
        .rpc('radar_possiveis_vinculos', { p_cnpj: cnpj as string })
        .range(0, 9);
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('radar_possiveis_vinculos: resposta fora da forma esperada (lista)');
      return data.map(lerVinculo);
    },
  });
}
