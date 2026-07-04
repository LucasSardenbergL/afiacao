// src/hooks/useCustoPrazoRegua.ts
// F2 — resolve o custo do prazo para a régua: taxa de custo de capital (RPC fin_regua_custo_capital)
// + dias parseados da condição selecionada (RPC fin_regua_condicao_prazo + parser TS puro).
// Ambas as RPCs são SECURITY DEFINER (RLS-safe; empresa_configuracao_custos e o catálogo de condições
// são staff-only sem grant a authenticated) e NÃO estão nos tipos gerados → cast via unknown.
// Degrada honesto para null em TODA ausência (config/condição ausente, código nulo, texto não parseável).
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { parsePrazoRecebimento } from '@/lib/regua-preco/prazo-helpers';

const STALE = 5 * 60_000; // taxa e condição mudam raramente

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export interface CustoPrazoRegua {
  prazoDias: number[] | null;
  custoCapitalAnual: number | null;
}

/** Taxa de custo de capital (fração a.a.) da empresa, via RPC RLS-safe. Guarda de unidade no cliente. */
function useCustoCapital(empresa: string | null) {
  return useQuery({
    queryKey: ['regua_custo_capital', empresa],
    enabled: Boolean(empresa),
    staleTime: STALE,
    queryFn: async (): Promise<number | null> => {
      const client = supabase as unknown as RpcClient;
      const { data, error } = await client.rpc('fin_regua_custo_capital', { p_empresa: empresa });
      if (error) throw new Error(error.message);
      const r = typeof data === 'number' ? data : null;
      return r != null && r > 0 && r < 1 ? r : null; // defesa: nunca aceita taxa ≥100% ou ≤0
    },
  });
}

/** descricao + num_parcelas da condição selecionada (RPC RLS-safe; RETURNS TABLE → array). */
function useCondicaoPrazo(empresa: string | null, codigo: string | null) {
  return useQuery({
    queryKey: ['regua_condicao_prazo', empresa, codigo],
    enabled: Boolean(empresa) && Boolean(codigo),
    staleTime: STALE,
    queryFn: async (): Promise<{ descricao: string | null; num_parcelas: number | null }> => {
      const client = supabase as unknown as RpcClient;
      const { data, error } = await client.rpc('fin_regua_condicao_prazo', {
        p_empresa: empresa,
        p_codigo: codigo,
      });
      if (error) throw new Error(error.message);
      const rows = Array.isArray(data)
        ? (data as { descricao?: string | null; num_parcelas?: number | null }[])
        : [];
      const row = rows[0];
      return { descricao: row?.descricao ?? null, num_parcelas: row?.num_parcelas ?? null };
    },
  });
}

/**
 * Resolve { prazoDias, custoCapitalAnual } para a régua incluir o custo do prazo.
 * Trocar a condição selecionada (codigo) reconsulta → o piso recalcula (snapshot consistente).
 */
export function useCustoPrazoRegua(empresa: string | null, codigo: string | null): CustoPrazoRegua {
  const rate = useCustoCapital(empresa);
  const cond = useCondicaoPrazo(empresa, codigo);
  const descricao = cond.data?.descricao ?? null;
  const numParcelas = cond.data?.num_parcelas ?? null;
  const custoCapitalAnual = rate.data ?? null;
  return useMemo<CustoPrazoRegua>(
    () => ({ prazoDias: parsePrazoRecebimento(descricao, numParcelas), custoCapitalAnual }),
    [descricao, numParcelas, custoCapitalAnual],
  );
}
