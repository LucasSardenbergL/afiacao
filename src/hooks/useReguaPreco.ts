import { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { avaliarReguaPreco } from '@/lib/regua-preco/regua-preco-helpers';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  dedupeFetchItens, montarInputRegua, chaveFetch,
  type ReguaCartItem, type FetchDataRegua, type PrazoRegua,
} from '@/lib/regua-preco/regua-preco-ui';

type RpcArgs = {
  p_customer: string;
  p_product: string;
  p_qty: number;
  p_preco_atual: number;
  p_prazo_dias: number[] | null;
};
type RpcResult = { data: FetchDataRegua | null; error: unknown };
const callRpc = (args: RpcArgs) =>
  (supabase.rpc as never as (fn: string, a: RpcArgs) => Promise<RpcResult>)('get_regua_preco', args);

/**
 * Régua de Preço por linha do carrinho. 1 useQuery dispara a RPC N× em paralelo
 * (Promise.allSettled — isola item lento/falho).
 *
 * ⚠️ FU4-F fase 2 — o PREÇO entrou na queryKey. Antes a decisão rodava no cliente a cada tecla,
 * de graça; agora ela é do servidor, porque um predicado `preço < piso` avaliável no browser
 * revela o piso por busca binária. O custo disso é refetch ao mudar o preço, contido por:
 *   · DEBOUNCE (400ms) — digitar não vira uma rajada de RPCs;
 *   · keepPreviousData — o sinal anterior fica na tela enquanto o novo chega (sem piscar);
 *   · dedupe por (produto, qty, preço) — linhas iguais continuam sendo 1 chamada só.
 * queryKey inclui o user.id REAL (anti-leak entre usuários no mesmo browser).
 */
export function useReguaPreco(
  itens: ReguaCartItem[],
  customerUserId: string | null,
  enabled: boolean,
  prazo?: PrazoRegua | null,
) {
  const { user } = useAuth();

  const prazoDias = prazo?.prazoDias ?? null;
  const prazoSig = prazoDias ? prazoDias.join('/') : '';

  // debounce sobre a ASSINATURA (não sobre o array): rajada de digitação colapsa numa chamada.
  const fetchItens = useMemo(() => dedupeFetchItens(itens), [itens]);
  const keysSig = fetchItens.map(chaveFetch).join(',');
  const debouncedSig = useDebouncedValue(`${keysSig}|${prazoSig}`, 400);

  const query = useQuery({
    queryKey: ['regua-preco', user?.id ?? 'anon', customerUserId, debouncedSig],
    enabled: enabled && !!customerUserId && fetchItens.length > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Map<string, FetchDataRegua>> => {
      // a query só dispara quando a assinatura DEBOUNCED muda; nesse instante `fetchItens` já
      // reflete o último preço digitado, então closure e chave estão coerentes.
      const alvo = fetchItens;
      const settled = await Promise.allSettled(
        alvo.map((f) =>
          callRpc({
            p_customer: customerUserId!,
            p_product: f.productId,
            p_qty: f.qty,
            p_preco_atual: f.precoAtual,
            p_prazo_dias: prazoDias,
          }),
        ),
      );
      const m = new Map<string, FetchDataRegua>();
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value.data) m.set(chaveFetch(alvo[i]), res.value.data);
      });
      return m;
    },
  });

  const reguaByKey = useMemo(() => {
    const out = new Map<string, ReguaPrecoResult>();
    const fetchMap = query.data;
    if (!fetchMap) return out;
    for (const it of itens) {
      // o veredito é POR PREÇO: se o preço mudou e o refetch ainda não voltou, não há entrada
      // para esta chave — melhor nenhum sinal que um sinal do preço anterior (precisão > recall).
      const fd = fetchMap.get(chaveFetch({ productId: it.productId, qty: it.qty, precoAtual: it.precoAtual }));
      if (!fd) continue;
      out.set(it.chave, avaliarReguaPreco(montarInputRegua(fd, it.precoAtual, { prazoDias })));
    }
    return out;
  }, [itens, query.data, prazoDias]);

  return { reguaByKey, isLoading: query.isLoading };
}
