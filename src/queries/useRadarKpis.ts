import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface RadarKpis {
  lote: string | null;
  novos: number;
  a_contatar: number;
  em_conversa: number;
  virou_cliente_mes: number;
}

export function useRadarKpis() {
  return useQuery({
    queryKey: ['radar', 'kpis'],
    queryFn: async (): Promise<RadarKpis> => {
      // TODO: tipos regeneram após apply da migration da fatia 2
      const { data, error } = await (supabase.rpc as (fn: string) => ReturnType<typeof supabase.rpc>)('radar_kpis');
      if (error) throw error;
      return data as unknown as RadarKpis;
    },
    staleTime: 60_000,
  });
}
