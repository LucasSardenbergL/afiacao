import { useQueries } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { EstadoIrmaos, IrmaosRaiz } from '@/lib/radar/ui-helpers';

export interface IrmaosDaFila {
  /** Dado por CNPJ, só para páginas já respondidas. */
  dados: Map<string, IrmaosRaiz>;
  /** Estado da página do CNPJ: 'carregando' | 'falhou' | 'ok'. CNPJ fora das páginas = 'carregando'. */
  estadoDe: (cnpj: string) => EstadoIrmaos;
}

/**
 * Filiais da mesma raiz de CNPJ para cada página carregada da fila — UMA chamada por página (≤ 50 CNPJs,
 * teto da RPC é 200), com chave estável por página: carregar a página 3 não refaz a 1 e a 2.
 * Só sinaliza: nada aqui muda a ordem nem esconde lead.
 */
export function useRadarIrmaos(paginas: { cnpj: string }[][]): IrmaosDaFila {
  return useQueries({
    queries: paginas.map((pagina) => {
      const cnpjs = pagina.map((e) => e.cnpj);
      return {
        queryKey: ['radar', 'irmaos', cnpjs],
        enabled: cnpjs.length > 0,
        staleTime: 5 * 60_000,
        retry: 1,
        queryFn: async (): Promise<{ cnpj: string; irmaos_na_fila: number; irmaos_clientes: number; cliente_nome: string | null }[]> => {
          const { data, error } = await supabase.rpc('radar_irmaos_por_raiz', { p_cnpjs: cnpjs });
          if (error) throw error;
          return data ?? [];
        },
      };
    }),
    combine: (resultados) => {
      const dados = new Map<string, IrmaosRaiz>();
      const estadoPorCnpj = new Map<string, EstadoIrmaos>();
      resultados.forEach((r, i) => {
        const estado: EstadoIrmaos = r.isError ? 'falhou' : r.isSuccess ? 'ok' : 'carregando';
        for (const e of paginas[i] ?? []) estadoPorCnpj.set(e.cnpj, estado);
        for (const linha of r.data ?? []) {
          dados.set(linha.cnpj, {
            irmaos_na_fila: linha.irmaos_na_fila,
            irmaos_clientes: linha.irmaos_clientes,
            cliente_nome: linha.cliente_nome,
          });
        }
      });
      return { dados, estadoDe: (cnpj: string) => estadoPorCnpj.get(cnpj) ?? 'carregando' };
    },
  });
}
