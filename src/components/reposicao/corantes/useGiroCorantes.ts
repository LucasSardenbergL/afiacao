import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { linhasCom } from '@/lib/linha-view';
import { paraGiroCorante } from '@/lib/reposicao/corantes-helpers';

/**
 * Giro dos 14 WP (OBEN), calculado no banco por `v_corante_giro` (security_invoker: customer lê 0
 * linhas). A view devolve uma linha por WP SEMPRE — sem cobertura, a faixa é "sem recomendação"
 * com o motivo. Erro de leitura LANÇA: a aba mostra o aviso, nunca uma lista vazia ou "0 ml".
 */
export function useGiroCorantes() {
  const query = useQuery({
    queryKey: ['reposicao', 'corantes', 'giro'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_corante_giro').select('*').order('wp_codigo');
      if (error) throw error;
      if (data == null) throw new Error('v_corante_giro: data=null sem error');
      return linhasCom(data, ['tint_corante_id', 'wp_codigo', 'faixa'] as const, 'v_corante_giro').map(paraGiroCorante);
    },
  });
  return { linhas: query.data, query };
}
