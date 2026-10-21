import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { RouteDisparoConfig } from '@/lib/whatsapp/disparo-config';


const COLS = 'disparo_inicio, disparo_corte, meta_tier_cap, win_back_reserva_pct, cold_start_piso_dia, capacidade_ligacoes_dia, cadencia_min_dias';

export function useRouteDisparoConfig() {
  return useQuery<RouteDisparoConfig | null>({
    queryKey: ['route-disparo-config'],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await supabase.from('route_disparo_config').select(COLS).eq('id', true).maybeSingle();
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
  });
}

export function useUpdateRouteDisparoConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: RouteDisparoConfig) => {
      const res = await supabase
        .from('route_disparo_config')
        .update({ ...cfg, updated_at: new Date().toISOString() })
        .eq('id', true);
      if (res.error) throw new Error(res.error.message); // RLS master-only barra não-master no servidor
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['route-disparo-config'] });
      qc.invalidateQueries({ queryKey: ['route-contact-list'] }); // re-ranqueia a lista ao vivo
    },
  });
}
