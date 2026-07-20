// src/hooks/useCustoPrazoRegua.ts
// F2 — resolve o PRAZO da régua: dias parseados da condição selecionada (RPC fin_regua_condicao_prazo
// + parser TS puro). A RPC é SECURITY DEFINER (RLS-safe; o catálogo de condições é staff-only sem
// grant a authenticated) e NÃO está nos tipos gerados → cast via unknown.
// Degrada honesto para null em TODA ausência (condição ausente, código nulo, texto não parseável).
//
// ⚠️ FU4-F fase 2: a TAXA de custo de capital saiu daqui. Ela só existia para alimentar
// `pisoComPrazo` no cliente, e a fórmula do piso foi para o servidor (private.regua_piso_calc) —
// `get_regua_preco` consulta `fin_regua_custo_capital` internamente. O cliente manda os DIAS e
// recebe o piso pronto; um parâmetro financeiro a menos trafegando para o browser.
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
 * Resolve { prazoDias } para a régua incluir o custo do prazo (que o SERVIDOR calcula).
 * Trocar a condição selecionada (codigo) reconsulta → o piso recalcula (snapshot consistente).
 */
export function useCustoPrazoRegua(empresa: string | null, codigo: string | null): CustoPrazoRegua {
  const cond = useCondicaoPrazo(empresa, codigo);
  const descricao = cond.data?.descricao ?? null;
  const numParcelas = cond.data?.num_parcelas ?? null;
  return useMemo<CustoPrazoRegua>(
    () => ({ prazoDias: parsePrazoRecebimento(descricao, numParcelas) }),
    [descricao, numParcelas],
  );
}
