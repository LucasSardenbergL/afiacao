import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { avaliarReguaPreco } from '@/lib/regua-preco/regua-preco-helpers';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';
import { montarInputRegua, type FetchData360, type FetchDataRegua } from '@/lib/regua-preco/regua-preco-ui';

type Rpc360Result = { data: FetchData360[] | null; error: unknown };
const callRpc360 = (args: { p_customer: string; p_omie_codigos: number[] }) =>
  (supabase.rpc as never as (fn: string, a: typeof args) => Promise<Rpc360Result>)(
    'get_regua_preco_customer360', args,
  );

/** Régua avaliada + o contexto (preço/qty) que a alimentou — pro componente readonly do 360. */
export interface Regua360Entry {
  result: ReguaPrecoResult;
  precoAtual: number;
  precoAtualAt: string | null;
  qtyRef: number;
}

/**
 * Régua de Preço no Customer 360 (readonly). 1 RPC batch resolve os ~10 SKUs preferidos
 * em 1 round-trip; a DECISÃO roda no helper (avaliarReguaPreco) — mesma fonte do carrinho,
 * zero divergência. `precoAtual` aqui é o ÚLTIMO preço REAL do cliente (vem da RPC, explícito),
 * não um campo editável. queryKey inclui o user.id REAL (anti-leak entre usuários no browser).
 */
export function useReguaPreco360(
  customerId: string | undefined,
  omieCodigos: number[],
  enabled: boolean,
) {
  const { user } = useAuth();
  const codigosSig = useMemo(() => [...omieCodigos].sort((a, b) => a - b).join(','), [omieCodigos]);

  const query = useQuery({
    queryKey: ['regua-preco-360', user?.id ?? 'anon', customerId, codigosSig],
    enabled: enabled && !!customerId && omieCodigos.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<FetchData360[]> => {
      const { data, error } = await callRpc360({ p_customer: customerId!, p_omie_codigos: omieCodigos });
      if (error) throw error;
      return data ?? [];
    },
  });

  const reguaByOmie = useMemo(() => {
    const out = new Map<number, Regua360Entry>();
    for (const row of query.data ?? []) {
      // sem_produto / sem_preco → não há o que avaliar (o componente apenas não renderiza nada).
      if (row.hide_reason != null || row.preco_atual == null) continue;
      const fd: FetchDataRegua = {
        cmc: row.cmc ?? null,
        cmc_confiavel: row.cmc_confiavel ?? false,
        aliquota_venda: row.aliquota_venda ?? 0,
        piso_mc: row.piso_mc ?? null,
        precos_cliente: row.precos_cliente ?? [],
        comparaveis: row.comparaveis ?? [],
      };
      out.set(row.omie_codigo, {
        result: avaliarReguaPreco(montarInputRegua(fd, row.preco_atual)),
        precoAtual: row.preco_atual,
        precoAtualAt: row.preco_atual_at,
        qtyRef: row.qty_ref ?? 0,
      });
    }
    return out;
  }, [query.data]);

  return { reguaByOmie, isLoading: query.isLoading };
}
