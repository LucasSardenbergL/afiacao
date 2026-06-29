import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { chaveCockpit } from '@/hooks/usePrecoCockpit';
import type { StatusDefasagem } from '@/lib/preco/defasagem';

/** Item de entrada da RPC de defasagem (1 por linha de produto do carrinho). */
export interface ItemDefasagemInput {
  empresa: string;
  codigo: number;
  preco: number;
  qty?: number;            // opcional (G5: ordem de grandeza âncora vs carrinho)
  tint_formula_id?: string | null;
}

/** Espelha o retorno por item de get_defasagem_cliente (Task 5). */
export interface LinhaDefasagem {
  codigo: number;
  empresa: string;
  status_defasagem: StatusDefasagem;
  tem_ancora: boolean;
  p_req: number | null;
  alta_custo_perc: number | null;
  data_ancora: string | null;   // 'MM/AAAA'
  motivo: string;
  calculated_at: string;
  // role-gated (gestor): null pra vendedora.
  p_last: number | null;
  c_last: number | null;
  c_now: number | null;
  markup_anterior: number | null;
}

type RpcResult = { data: LinhaDefasagem[] | null; error: unknown };
const callRpc = (args: { p_itens: ItemDefasagemInput[]; p_customer_user_id: string }) =>
  (supabase.rpc as never as (fn: string, a: typeof args) => Promise<RpcResult>)(
    'get_defasagem_cliente', args,
  );

/**
 * Defasagem de repasse por cliente, 1 batch por carrinho. Só dispara com cliente
 * selecionado e itens>0. queryKey inclui o user.id REAL (identidade, nunca a lente
 * "Ver como") — anti-leak de markup/custo entre usuários no mesmo browser. Falha da
 * RPC NÃO derruba o carrinho (a defasagem é informativa). Retorna mapa por chave
 * estável (chaveCockpit) pra casar com a linha.
 */
export function useDefasagemCliente(itens: ItemDefasagemInput[], customerUserId: string | null) {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ['defasagem-cliente', user?.id ?? 'anon', customerUserId, itens],
    enabled: !!customerUserId && itens.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<LinhaDefasagem[]> => {
      const { data, error } = await callRpc({ p_itens: itens, p_customer_user_id: customerUserId! });
      if (error) throw error;
      return (data as LinhaDefasagem[]) ?? [];
    },
  });

  // Casa por chave estável (NA ORDEM do input — a RPC devolve 1 linha por item, em ordem).
  const defasagemByKey = useMemo(() => {
    const m = new Map<string, LinhaDefasagem>();
    const list = query.data;
    if (!list) return m;
    itens.forEach((inp, i) => {
      const l = list[i];
      if (l) m.set(chaveCockpit(inp.empresa, inp.codigo, inp.tint_formula_id), l);
    });
    return m;
  }, [itens, query.data]);

  return { defasagemByKey, isLoading: query.isLoading };
}
