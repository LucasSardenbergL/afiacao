import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { presetParaParams, digitosCnae } from '@/lib/radar/ui-helpers';
import type { RadarFiltros } from '@/queries/useRadarLista';

export interface RadarMunicipioContagem {
  municipio_codigo: string;
  municipio_nome: string;
  uf: string;
  lat: number | null;
  lng: number | null;
  total: number;
  com_telefone: number;
  a_contatar: number;
}

// Agrega por município respeitando os filtros ESTRUTURAIS (não a busca textual livre —
// busca por nome é p/ achar 1 empresa, não p/ ranking geográfico; omitir evita o ILIKE '%%' full-scan).
// Alimenta ranking ("onde caçar") + totalizador + mapa — um backend, três usos.
export function useRadarContagemMunicipios(filtros: RadarFiltros, hojeISO: string, enabled: boolean) {
  const p = presetParaParams(filtros.preset, hojeISO);
  const cnae = digitosCnae(filtros.cnae);
  const params = {
    p_uf: filtros.uf || null,
    p_cnae_exato: cnae.length === 7 ? cnae : null,
    p_cnae_prefix: cnae.length > 0 && cnae.length < 7 ? cnae : null,
    p_status: filtros.status || null,
    p_incluir_ja_clientes: filtros.incluirJaClientes,
    p_data_abertura_min: p.dataAberturaMin,
    p_data_abertura_max: p.dataAberturaMax,
    p_limit: 500,
  };
  return useQuery({
    queryKey: ['radar', 'contagem-municipios', params],
    enabled,
    queryFn: async (): Promise<RadarMunicipioContagem[]> => {
      // TODO: cast até o Lovable regenerar os tipos pós-migration (lição §10 CLAUDE.md)
      const { data, error } = await (
        supabase.rpc as (fn: string, args: unknown) => ReturnType<typeof supabase.rpc>
      )('radar_contagem_por_municipio', params);
      if (error) throw error;
      return (data ?? []) as unknown as RadarMunicipioContagem[];
    },
    staleTime: 60_000,
  });
}
