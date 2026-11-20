import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { parseMetaResposta, type MetaResposta } from '@/lib/dashboard/meta-potencial';

/**
 * Meta do mês por potencial da carteira (master-only no banco). A RPC congela a meta no 1º acesso a partir do
 * dia 3 e registra a abertura no ledger `meta_potencial_visualizacao` — é o SENSOR da superfície.
 * Chave sem a seleção de empresa: o recorte é feito no cliente (trocar de empresa não conta abertura nova).
 * Erro LANÇA → "meta indisponível" no tile; a receita continua aparecendo.
 */
export function useMetaPotencial() {
  return useQuery({
    queryKey: ['meta-potencial'],
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    queryFn: async (): Promise<MetaResposta> => {
      const { data, error } = await supabase.rpc('meta_potencial_mes');
      if (error) throw new Error(`meta_potencial_mes: ${error.message}`);
      return parseMetaResposta(data);
    },
  });
}
