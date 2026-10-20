import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ilike, ilikeOr, isSearchablePostgrestTerm, likePrefixPattern } from '@/lib/postgrest';
import { presetParaParams, digitosCnae, type PresetRadar } from '@/lib/radar/ui-helpers';
import { lerLoteVigente } from '@/queries/useRadarLoteVigente';
import type { Database } from '@/integrations/supabase/types';

export type RadarEmpresa = Database['public']['Tables']['radar_empresas']['Row'];

export interface RadarFiltros {
  busca: string;
  uf: string;            // '' = todas
  municipio: string;     // '' = todos
  cnae: string;          // '' = todos (1 código por enquanto)
  status: string;        // '' = qualquer; senão um prospeccao_status
  incluirJaClientes: boolean;
  comTelefone: boolean;  // só empresas com telefone1 OU telefone2
  preset: PresetRadar;
  incluirSaiuDoDump: boolean; // default false: a fila é a FOTO VIGENTE (ultimo_lote = lote vigente)
  soIneditos: boolean;        // só quem entrou no universo NESTE lote (primeira_vista_em >= iniciado_em)
}

const PAGE = 50;

export function useRadarLista(filtros: RadarFiltros, hojeISO: string) {
  const qc = useQueryClient();
  return useInfiniteQuery({
    queryKey: ['radar', 'lista', filtros, hojeISO],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      // Lote vigente ANTES de montar a query: mesma chave/cache do `useRadarLoteVigente`
      // (lido uma vez, não por componente). Se a leitura do lote falha, a lista falha junto —
      // mostrar a fila sem saber o lote seria mostrar a foto velha de novo (52.011 leads com
      // ultimo_lote=2026-05 na fila de 2026-08, medido 2026-10-19).
      const lote = await lerLoteVigente(qc);
      const p = presetParaParams(filtros.preset, hojeISO);
      let q = supabase.from('radar_empresas').select('*');

      // só-wildcard (`*`/`%%`) sanitiza pra vazio → `.or()` match-all (#1062); pula o filtro (lista base)
      if (isSearchablePostgrestTerm(filtros.busca.trim())) q = q.or(ilikeOr(['razao_social', 'nome_fantasia'], filtros.busca.trim()));
      if (filtros.uf) q = q.eq('uf', filtros.uf);
      // Município: o banco guarda em MAIÚSCULAS (dump RFB, "BELO HORIZONTE"); o usuário
      // digita como quiser → ilike (case-insensitive + parcial, sanitizado). Limitação
      // conhecida: ilike não é acento-insensitive ("sao" não casa "SÃO") — v2 com unaccent.
      if (isSearchablePostgrestTerm(filtros.municipio.trim())) q = q.or(ilike('municipio_nome', filtros.municipio.trim()));
      // CNAE: o banco guarda 7 dígitos puros; o usuário digita o formato oficial
      // (3101-2/00). Normaliza p/ dígitos. Completo (7) = match exato pelo índice;
      // parcial = prefix match (a família do CNAE). Vazio = sem filtro (null do helper).
      const cnaeDigitos = digitosCnae(filtros.cnae);
      const cnaePrefixo = likePrefixPattern(cnaeDigitos);
      if (cnaeDigitos.length === 7) q = q.eq('cnae_principal', cnaeDigitos);
      else if (cnaePrefixo) q = q.like('cnae_principal', cnaePrefixo);
      if (filtros.status) q = q.eq('prospeccao_status', filtros.status);
      else q = q.neq('prospeccao_status', 'descartado'); // fila default esconde descartados
      if (!filtros.incluirJaClientes) q = q.eq('ja_cliente', false);
      // Foto VIGENTE: default só `ultimo_lote = vigente`; "incluir quem saiu do dump" solta o
      // filtro. "Só inéditos" é o predicado do card (`ehInedito`): vigente E primeira vista no
      // lote — e vence o toggle (inédito é, por definição, do lote vigente). Sem lote completo
      // (`null`) não há foto para filtrar: a fila roda inteira, como a RPC `radar_kpis`.
      if (lote && filtros.soIneditos) {
        q = q.eq('ultimo_lote', lote.mes_referencia).gte('primeira_vista_em', lote.iniciado_em);
      } else if (lote && !filtros.incluirSaiuDoDump) {
        q = q.eq('ultimo_lote', lote.mes_referencia);
      }
      // "com telefone" = positivo (linha sem telefone não casa o OR; sem footgun NULL-blind)
      if (filtros.comTelefone) q = q.or('telefone1.not.is.null,telefone2.not.is.null');
      if (p.dataAberturaMax) q = q.lte('data_abertura', p.dataAberturaMax);
      if (p.dataAberturaMin) q = q.gte('data_abertura', p.dataAberturaMin);

      const from = (pageParam as number) * PAGE;
      const { data, error } = await q
        .order(p.orderColumn, { ascending: p.orderAsc, nullsFirst: false }) // preset 'score': score DESC NULLS LAST (idx_radar_lista_score)
        .order('cnpj', { ascending: true }) // tie-break estável p/ paginação
        .range(from, from + PAGE - 1);
      if (error) throw error;
      return data as RadarEmpresa[];
    },
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length : undefined),
    staleTime: 30_000,
  });
}
