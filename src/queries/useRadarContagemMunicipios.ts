import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { presetParaParams, digitosCnae } from '@/lib/radar/ui-helpers';
import { recorteDeLote } from '@/lib/radar/lote-vigente';
import { lerLoteVigente } from '@/queries/useRadarLoteVigente';
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
//
// Universo = o da FILA: o recorte de lote (foto vigente / só inéditos / incluir quem saiu) é o
// mesmo `recorteDeLote` de `useRadarLista`, sobre o lote lido por `lerLoteVigente` (mesma chave
// e cache) — ranking e mapa não recomputam "qual é o lote". Sem isto o totalizador contava os
// 52.011 que saíram do dump de 2026-08 (São Paulo 26.794 no ranking × 24.910 na fila).
export function useRadarContagemMunicipios(filtros: RadarFiltros, hojeISO: string, enabled: boolean) {
  const qc = useQueryClient();
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
  const modoLote = { incluirSaiuDoDump: filtros.incluirSaiuDoDump, soIneditos: filtros.soIneditos };
  return useQuery({
    queryKey: ['radar', 'contagem-municipios', params, modoLote],
    enabled,
    queryFn: async (): Promise<RadarMunicipioContagem[]> => {
      // Se a leitura do lote falha, o ranking falha junto — contar sem saber o lote seria
      // voltar a contar a foto velha.
      const recorte = recorteDeLote(await lerLoteVigente(qc), modoLote);
      // TODO: cast até o Lovable regenerar os tipos pós-migration (lição §10 CLAUDE.md)
      const { data, error } = await (
        supabase.rpc as (fn: string, args: unknown) => ReturnType<typeof supabase.rpc>
      )('radar_contagem_por_municipio', {
        ...params,
        p_lote: recorte.ultimoLote,
        p_primeira_vista_min: recorte.primeiraVistaMin,
      });
      if (error) throw error;
      return (data ?? []) as unknown as RadarMunicipioContagem[];
    },
    staleTime: 60_000,
  });
}
