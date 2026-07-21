import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
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
 * revela o piso por busca binária. O custo disso é refetch ao mudar o preço, contido por
 * DEBOUNCE (400ms) e por dedupe em (produto, qty, preço).
 *
 * ⚠️ SEM `keepPreviousData`, e isso é DELIBERADO (achado P1 do Codex na 1ª revisão): o `Map` é
 * chaveado por produto+qty+preço, que NÃO inclui cliente nem prazo. Servir o dado da query
 * anterior enquanto a nova carrega faria a chave casar entre contextos diferentes — o veredito do
 * cliente A aparecendo no cliente B, e o piso À VISTA escondendo o vermelho depois de trocar a
 * condição para 90 dias. Preferimos o sinal SUMIR por ~400ms a mostrar o sinal do contexto errado
 * (precisão > recall). Quem depende disso é o vermelho de margem.
 *
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
  //
  // ⚠️ SÓ o preço é debounced; `prazoSig` entra CRU na queryKey (achado P2 da rodada 2 do Codex).
  // Debouncar o prazo junto abria uma janela de 400ms em que a condição já mudou, a queryKey ainda
  // não, e o `Map` antigo — que não contém prazo na chave — seguia casando: trocar para 90 dias
  // deixava o vermelho ESCONDIDO durante o intervalo, com o piso à vista. Prazo é escolha discreta
  // num dropdown, não digitação, então não há rajada a colapsar: debouncá-lo só criava o buraco.
  const fetchItens = useMemo(() => dedupeFetchItens(itens), [itens]);
  const keysSig = fetchItens.map(chaveFetch).join(',');
  const debouncedKeysSig = useDebouncedValue(keysSig, 400);
  const querySig = `${debouncedKeysSig}|${prazoSig}`;

  const query = useQuery({
    queryKey: ['regua-preco', user?.id ?? 'anon', customerUserId, querySig],
    enabled: enabled && !!customerUserId && fetchItens.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, FetchDataRegua>> => {
      // a query dispara quando a assinatura debounced (preço) OU o prazo cru mudam; nos dois casos
      // `fetchItens` já reflete o estado atual, então closure e chave ficam coerentes.
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
    // fail-closed: se a flag/role desligar (ou sumir o cliente), o React Query MANTÉM o cache de
    // query.data — então gateamos AQUI também, para o sinal sumir na hora. O 360 já fazia isso
    // (useReguaPreco360.ts:52); o carrinho não, e a inconsistência foi apontada na revisão.
    if (!enabled || !customerUserId) return out;
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
  }, [itens, query.data, prazoDias, enabled, customerUserId]);

  return { reguaByKey, isLoading: query.isLoading };
}
