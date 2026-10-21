import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import {
  listaJson, numeroJson, numeroOuNuloJson, objetoJson, textoJson, textoOuNuloJson,
} from '@/lib/json-forma';
import { useAuth } from '@/contexts/AuthContext';
import { chaveCockpit } from '@/hooks/usePrecoCockpit';
import type { StatusDefasagem } from '@/lib/preco/defasagem';

/** Item de entrada da RPC de defasagem (1 por linha de produto do carrinho). */
// `type`, não `interface`: o array vai direto no `p_itens` (Json), que exige assinatura de índice.
export type ItemDefasagemInput = {
  empresa: string;
  codigo: number;
  preco: number;
  qty?: number;            // opcional (G5: ordem de grandeza âncora vs carrinho)
  tint_formula_id?: string | null;
};

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

const STATUS_DEFASAGEM: readonly StatusDefasagem[] = [
  'defasado', 'em_dia', 'sem_historico', 'sem_alta', 'revisar', 'sem_custo_atual_fresco', 'sem_data_confiavel', 'neutro',
];

/**
 * Uma linha do jsonb de `get_defasagem_cliente`, lida por forma contra o `jsonb_build_object` da prod.
 * Os absolutos role-gated chegam NULL explícito para a vendedora e continuam NULL (nunca 0); status
 * fora do vocabulário, chave ausente ou tipo trocado LANÇAM.
 */
function linhaDefasagemDoJson(v: Json): LinhaDefasagem {
  const fonte = 'get_defasagem_cliente';
  const o = objetoJson(v, fonte);
  const status = textoJson(o, 'status_defasagem', fonte);
  const statusDefasagem = STATUS_DEFASAGEM.find((s) => s === status);
  if (!statusDefasagem) throw new Error(`${fonte}: status_defasagem desconhecido (${status})`);
  if (typeof o.tem_ancora !== 'boolean') throw new Error(`${fonte}: "tem_ancora" fora da forma (booleano)`);
  return {
    codigo: numeroJson(o, 'codigo', fonte),
    empresa: textoJson(o, 'empresa', fonte),
    status_defasagem: statusDefasagem,
    tem_ancora: o.tem_ancora,
    p_req: numeroOuNuloJson(o, 'p_req', fonte),
    alta_custo_perc: numeroOuNuloJson(o, 'alta_custo_perc', fonte),
    data_ancora: textoOuNuloJson(o, 'data_ancora', fonte),
    motivo: textoJson(o, 'motivo', fonte),
    calculated_at: textoJson(o, 'calculated_at', fonte),
    p_last: numeroOuNuloJson(o, 'p_last', fonte),
    c_last: numeroOuNuloJson(o, 'c_last', fonte),
    c_now: numeroOuNuloJson(o, 'c_now', fonte),
    markup_anterior: numeroOuNuloJson(o, 'markup_anterior', fonte),
  };
}

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
      const { data, error } = await supabase.rpc('get_defasagem_cliente', {
        p_itens: itens,
        p_customer_user_id: customerUserId!,
      });
      if (error) throw error;
      return listaJson(data, 'get_defasagem_cliente').map(linhaDefasagemDoJson);
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
