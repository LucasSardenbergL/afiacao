import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Em quantas OUTRAS raízes de CNPJ cada telefone do lead aparece (RPC `radar_telefone_compartilhado`, migration
 * 20261029201200). Aviso para o vendedor, nunca classificação: erro de leitura é `isError` (a ficha diz que não
 * conseguiu verificar), não "número exclusivo".
 */
export function useRadarTelefoneCompartilhado(cnpj: string | null) {
  return useQuery({
    queryKey: ['radar', 'telefone-compartilhado', cnpj],
    enabled: !!cnpj,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabase.rpc('radar_telefone_compartilhado', { p_cnpj: cnpj as string });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('radar_telefone_compartilhado: resposta fora da forma esperada (lista)');
      const m = new Map<string, number>();
      for (const l of data) {
        if (typeof l?.telefone !== 'string' || typeof l?.outras_raizes !== 'number') {
          throw new Error('radar_telefone_compartilhado: resposta fora da forma esperada ({telefone, outras_raizes})');
        }
        m.set(l.telefone, l.outras_raizes);
      }
      return m;
    },
  });
}
