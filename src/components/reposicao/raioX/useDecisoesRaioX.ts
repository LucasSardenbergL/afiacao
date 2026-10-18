// Decisões do Raio-X vigentes para um conjunto de SKUs (selo no pedido de compra). Só os destinos de
// SAÍDA entram (trocar/liquidar/manter_suspender_recompra) — venda_dirigida etc. não são aviso de compra.
// Leitura sob RLS (cap_custo_ler): sem permissão = 0 linhas, sem erro => sem selo (Ruling S5). O selo é
// AVISO: falha de leitura resolve para "sem selo", nunca estoura nem bloqueia quem chama.
// Key sob ['raio-x', empresa, 'selo', ...] (Ruling S1) para a invalidação das mutações cobrir o selo.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Empresa } from '@/lib/reposicao/raio-x/tipos';

export const DESTINOS_COM_SELO = ['trocar', 'liquidar', 'manter_suspender_recompra'] as const;

export interface DecisaoSelo {
  destino: string;
  decidido_em: string | null;
  decidido_por_nome: string | null;
}

// Teto do PostgREST é 1.000 linhas por resposta: a lista de SKUs é fatiada (uma decisão por SKU+empresa).
const FATIA = 500;

export function useDecisoesRaioX(empresa: Empresa, skus: string[]) {
  const ordenados = [...new Set(skus)].sort();
  return useQuery({
    queryKey: ['raio-x', empresa, 'selo', ...ordenados],
    enabled: ordenados.length > 0,
    retry: 1,
    queryFn: async (): Promise<Map<string, DecisaoSelo>> => {
      const mapa = new Map<string, DecisaoSelo>();
      try {
        const numeros = ordenados.map(Number).filter((n) => Number.isFinite(n));
        const linhas: Array<{ sku_codigo_omie: number; destino: string | null; decidido_em: string | null; decidido_por: string | null }> = [];
        for (let i = 0; i < numeros.length; i += FATIA) {
          const { data, error } = await supabase
            .from('raio_x_decisao')
            .select('sku_codigo_omie, destino, decidido_em, decidido_por')
            .eq('empresa', empresa)
            .in('sku_codigo_omie', numeros.slice(i, i + FATIA))
            .in('destino', [...DESTINOS_COM_SELO]);
          if (error) return new Map();
          linhas.push(...((data ?? []) as typeof linhas));
        }
        const autores = [...new Set(linhas.map((l) => l.decidido_por).filter((x): x is string => !!x))];
        const nomes = new Map<string, string>();
        if (autores.length > 0) {
          const { data, error } = await supabase.from('profiles').select('user_id, name').in('user_id', autores);
          if (!error) for (const p of data ?? []) if (p.name) nomes.set(p.user_id, p.name);
        }
        for (const l of linhas) {
          // Defesa em profundidade: o filtro do servidor já restringe, mas o selo nunca depende só dele.
          if (!l.destino || !(DESTINOS_COM_SELO as readonly string[]).includes(l.destino)) continue;
          mapa.set(String(l.sku_codigo_omie), {
            destino: l.destino,
            decidido_em: l.decidido_em,
            decidido_por_nome: l.decidido_por ? (nomes.get(l.decidido_por) ?? null) : null,
          });
        }
        return mapa;
      } catch {
        return new Map();
      }
    },
  });
}
