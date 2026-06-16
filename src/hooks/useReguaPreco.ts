import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { avaliarReguaPreco } from '@/lib/regua-preco/regua-preco-helpers';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';
import {
  dedupeFetchItens, montarInputRegua, chaveFetch,
  type ReguaCartItem, type FetchDataRegua,
} from '@/lib/regua-preco/regua-preco-ui';

type RpcResult = { data: FetchDataRegua | null; error: unknown };
const callRpc = (args: { p_customer: string; p_product: string; p_qty: number }) =>
  (supabase.rpc as never as (fn: string, a: typeof args) => Promise<RpcResult>)('get_regua_preco', args);

/**
 * Régua de Preço por linha do carrinho. 1 useQuery dispara a RPC fetcher N× em
 * paralelo (Promise.allSettled — isola item lento/falho); a decisão roda no helper
 * client-side (useMemo) a cada mudança de preço, SEM re-buscar (queryKey não tem preço).
 * queryKey inclui o user.id REAL (anti-leak entre usuários no mesmo browser).
 */
export function useReguaPreco(itens: ReguaCartItem[], customerUserId: string | null, enabled: boolean) {
  const { user } = useAuth();
  const fetchItens = useMemo(() => dedupeFetchItens(itens), [itens]);
  const fetchKeysSig = fetchItens.map(chaveFetch).join(',');

  const query = useQuery({
    queryKey: ['regua-preco', user?.id ?? 'anon', customerUserId, fetchKeysSig],
    enabled: enabled && !!customerUserId && fetchItens.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, FetchDataRegua>> => {
      const settled = await Promise.allSettled(
        fetchItens.map((f) => callRpc({ p_customer: customerUserId!, p_product: f.productId, p_qty: f.qty })),
      );
      const m = new Map<string, FetchDataRegua>();
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value.data) m.set(chaveFetch(fetchItens[i]), res.value.data);
      });
      return m;
    },
  });

  const reguaByKey = useMemo(() => {
    const out = new Map<string, ReguaPrecoResult>();
    const fetchMap = query.data;
    if (!fetchMap) return out;
    for (const it of itens) {
      const fd = fetchMap.get(`${it.productId}:${it.qty}`);
      if (!fd) continue;
      out.set(it.chave, avaliarReguaPreco(montarInputRegua(fd, it.precoAtual)));
    }
    return out;
  }, [itens, query.data]);

  return { reguaByKey, isLoading: query.isLoading };
}
