import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ilikeOr } from '@/lib/postgrest';
import { presetParaParams, type PresetRadar } from '@/lib/radar/ui-helpers';
import type { Database } from '@/integrations/supabase/types';

export type RadarEmpresa = Database['public']['Tables']['radar_empresas']['Row'];

export interface RadarFiltros {
  busca: string;
  uf: string;            // '' = todas
  municipio: string;     // '' = todos
  cnae: string;          // '' = todos (1 código por enquanto)
  status: string;        // '' = qualquer; senão um prospeccao_status
  incluirJaClientes: boolean;
  preset: PresetRadar;
}

const PAGE = 50;

export function useRadarLista(filtros: RadarFiltros, hojeISO: string) {
  return useInfiniteQuery({
    queryKey: ['radar', 'lista', filtros, hojeISO],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const p = presetParaParams(filtros.preset, hojeISO);
      let q = supabase.from('radar_empresas').select('*');

      if (filtros.busca.trim()) q = q.or(ilikeOr(['razao_social', 'nome_fantasia'], filtros.busca.trim()));
      if (filtros.uf) q = q.eq('uf', filtros.uf);
      if (filtros.municipio) q = q.eq('municipio_nome', filtros.municipio);
      if (filtros.cnae) q = q.eq('cnae_principal', filtros.cnae);
      if (filtros.status) q = q.eq('prospeccao_status', filtros.status);
      else q = q.neq('prospeccao_status', 'descartado'); // fila default esconde descartados
      if (!filtros.incluirJaClientes) q = q.eq('ja_cliente', false);
      if (p.dataAberturaMax) q = q.lte('data_abertura', p.dataAberturaMax);
      if (p.dataAberturaMin) q = q.gte('data_abertura', p.dataAberturaMin);

      const from = (pageParam as number) * PAGE;
      const { data, error } = await q
        .order(p.orderColumn, { ascending: p.orderAsc, nullsFirst: false })
        .order('cnpj', { ascending: true }) // tie-break estável p/ paginação
        .range(from, from + PAGE - 1);
      if (error) throw error;
      return data as RadarEmpresa[];
    },
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length : undefined),
    staleTime: 30_000,
  });
}
