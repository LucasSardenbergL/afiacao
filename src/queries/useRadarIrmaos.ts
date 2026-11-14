import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
 * Só sinaliza: nada aqui muda a ordem nem esconde lead. A chave é a de `chaveEstavelDaPagina`.
 */
export function useRadarIrmaos(paginas: { cnpj: string }[][]): IrmaosDaFila {
  const qc = useQueryClient();
  return useQueries({
    queries: paginas.map((pagina) => {
      const cnpjs = chaveEstavelDaPagina(qc, 'irmaos', pagina.map((e) => e.cnpj));
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

/**
 * Chave ESTÁVEL de um selo por página (revisão 2026-11-11, item 1). A chave é a lista de CNPJs da página; quando um
 * lead sai dela no lugar (`aplicarLeadNasPaginas`, depois de um contato) a lista encolhe, a chave mudava e a página
 * inteira voltava a "carregando" com uma RPC nova — por um dado que o cache JÁ tem (a resposta é por CNPJ).
 * Se uma consulta já respondida do mesmo selo cobre TODOS os CNPJs da página, a página segue nela: mesma chave, zero
 * RPC, nenhum selo piscando. Página com CNPJ novo (releitura, página seguinte) ganha chave própria, como antes.
 */
export function chaveEstavelDaPagina(qc: QueryClient, selo: 'irmaos' | 'vinculos-lista', cnpjs: string[]): string[] {
  if (cnpjs.length === 0) return cnpjs;
  for (const q of qc.getQueryCache().findAll({ queryKey: ['radar', selo] })) {
    const chave = q.queryKey[2];
    if (q.state.data === undefined || !Array.isArray(chave) || chave.length < cnpjs.length) continue;
    const cobre = new Set(chave as string[]);
    if (cnpjs.every((c) => cobre.has(c))) return chave as string[];
  }
  return cnpjs;
}
