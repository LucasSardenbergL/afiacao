import { useQueries, useQueryClient } from '@tanstack/react-query';
import { chaveEstavelDaPagina } from '@/queries/useRadarIrmaos';
import { supabase } from '@/integrations/supabase/client';
import { lerResumoVinculo, type EstadoVinculos, type ResumoVinculoLista } from '@/lib/radar/vinculos';

export interface VinculosDaFila {
  /** Resumo por CNPJ, só dos leads COM vínculo em páginas já respondidas. */
  dados: Map<string, ResumoVinculoLista>;
  /** Estado da página do CNPJ: 'carregando' | 'falhou' | 'ok'. CNPJ fora das páginas = 'carregando'. */
  estadoDe: (cnpj: string) => EstadoVinculos;
}

/**
 * "Possível sucessor / vínculo com cliente" para cada página carregada da fila — UMA chamada por página (≤ 50 CNPJs;
 * a RPC `radar_vinculos_por_cnpjs` recusa acima de 200), chave estável por página, como `useRadarIrmaos`. O servidor
 * usa o MESMO núcleo de regras da ficha (migration 20261106083754). Só sinaliza: não muda ordem nem esconde lead.
 * Erro ou forma inesperada marcam a página como 'falhou' — nunca "sem vínculo".
 */
export function useRadarVinculosLista(paginas: { cnpj: string }[][]): VinculosDaFila {
  const qc = useQueryClient();
  return useQueries({
    queries: paginas.map((pagina) => {
      const cnpjs = chaveEstavelDaPagina(qc, 'vinculos-lista', pagina.map((e) => e.cnpj));
      return {
        queryKey: ['radar', 'vinculos-lista', cnpjs],
        enabled: cnpjs.length > 0,
        staleTime: 10 * 60_000,
        retry: 1,
        queryFn: async () => {
          // Uma linha por lead COM vínculo, no máximo uma por CNPJ pedido (≤ 200); o range explicita o teto.
          const { data, error } = await supabase
            .rpc('radar_vinculos_por_cnpjs', { p_cnpjs: cnpjs })
            .range(0, 199);
          if (error) throw error;
          if (!Array.isArray(data)) throw new Error('radar_vinculos_por_cnpjs: resposta fora da forma esperada (lista)');
          return data.map(lerResumoVinculo);
        },
      };
    }),
    combine: (resultados) => {
      const dados = new Map<string, ResumoVinculoLista>();
      const estadoPorCnpj = new Map<string, EstadoVinculos>();
      resultados.forEach((r, i) => {
        // Um refetch que falha sobre dado já lido mantém o dado (é resposta real); falha sem dado = "não consegui".
        const estado: EstadoVinculos = r.data ? 'ok' : r.isError ? 'falhou' : 'carregando';
        for (const e of paginas[i] ?? []) estadoPorCnpj.set(e.cnpj, estado);
        for (const linha of r.data ?? []) dados.set(linha.cnpj, linha.resumo);
      });
      return { dados, estadoDe: (cnpj: string) => estadoPorCnpj.get(cnpj) ?? 'carregando' };
    },
  });
}
