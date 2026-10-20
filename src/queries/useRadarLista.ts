import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ilike, ilikeOr, isSearchablePostgrestTerm, likePrefixPattern } from '@/lib/postgrest';
import { presetParaParams, digitosCnae, versaoDaFila, type PresetRadar } from '@/lib/radar/ui-helpers';
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
}

const PAGE = 50;

// acoes_execucoes não está no types.ts gerado (regen é do Lovable) → cast estrutural mínimo (idioma do useUltimaExecucao).
interface SelectRodadaScore {
  from(tabela: 'acoes_execucoes'): {
    select(colunas: 'id'): {
      eq(coluna: 'acao', valor: string): {
        eq(coluna: 'status', valor: string): {
          order(coluna: 'iniciado_em', opcoes: { ascending: boolean }): {
            limit(n: number): PromiseLike<{ data: { id: string }[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
}

/** Id da rodada mais recente do score (ledger `radar.score_recalcular`). Revisado a cada 10 min: a rodada
 *  diária (03:30 BRT) ou uma manual troca a versão da fila e reinicia a paginação. */
export function useRadarRodadaScore() {
  return useQuery({
    queryKey: ['radar', 'rodada-score'],
    refetchInterval: 10 * 60_000,
    retry: 1,
    queryFn: async () => {
      const cliente = supabase as unknown as SelectRodadaScore;
      const { data, error } = await cliente
        .from('acoes_execucoes')
        .select('id')
        .eq('acao', 'radar.score_recalcular')
        .eq('status', 'sucesso')
        .order('iniciado_em', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0]?.id ?? null;
    },
  });
}

export function useRadarLista(filtros: RadarFiltros, hojeISO: string) {
  const rodada = useRadarRodadaScore();
  const versao = versaoDaFila(filtros.preset, rodada.data);
  return useInfiniteQuery({
    queryKey: ['radar', 'lista', filtros, hojeISO, versao],
    // Fila por score espera a versão (sucesso OU erro) para não buscar duas vezes na abertura; leitura do
    // ledger que falha degrada para 'sem-rodada' — a lista continua, só sem o reinício automático.
    enabled: filtros.preset !== 'score' || !rodada.isPending,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
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
