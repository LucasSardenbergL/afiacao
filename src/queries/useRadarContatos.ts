import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

export type RadarContato = Database['public']['Tables']['radar_contatos']['Row'];

export const LIMITE_HISTORICO_RADAR = 20;

/**
 * Histórico de contatos de um lead (`radar_contatos`, RLS gestor/master já existente).
 * Últimos N, mais recente primeiro. Quem consome distingue erro de vazio (estadoDeLeitura).
 */
export function useRadarContatos(cnpj: string | null) {
  return useQuery({
    queryKey: ['radar', 'contatos', cnpj],
    enabled: !!cnpj,
    queryFn: async (): Promise<RadarContato[]> => {
      const { data, error } = await supabase
        .from('radar_contatos')
        .select('*')
        .eq('cnpj', cnpj as string)
        .order('created_at', { ascending: false })
        .range(0, LIMITE_HISTORICO_RADAR - 1);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
  });
}
