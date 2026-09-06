// Itens de TODOS os pedidos pendentes do ciclo numa única query (M-03, Codex P1/P2).
//
// A cardinalidade (1 SKU × vários) tem de vir dos ITENS, nunca de `num_skus`: essa coluna é justamente a
// que o editor antigo corrompia. E carregar por linha seria N+1 (~36 GETs num ciclo de 100 pedidos).
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ItemDoPedido } from "./types";

/** Capa silenciosa do PostgREST (CLAUDE.md): bater nela = leitura PARCIAL, que aqui vira erro, não "ok". */
const CAPA_POSTGREST = 1000;

export type ItensPorPedido = Map<number, ItemDoPedido[]>;

export function useItensDosPedidos(ids: readonly number[]) {
  const chave = [...ids].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["cockpit-itens-dos-pedidos", chave],
    enabled: chave.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<ItensPorPedido> => {
      const { data, error } = await supabase
        .from("pedido_compra_item")
        .select("id, pedido_id, qtde_final, qtde_sugerida, preco_unitario, fator_embalagem_portal")
        .in("pedido_id", chave)
        .order("id");
      if (error) throw error;
      const linhas = (data ?? []) as (ItemDoPedido & { pedido_id: number })[];
      if (linhas.length >= CAPA_POSTGREST) {
        throw new Error(`itens do ciclo acima da capa de ${CAPA_POSTGREST} linhas — leitura parcial não vale como verdade`);
      }
      const m: ItensPorPedido = new Map();
      for (const it of linhas) {
        const lista = m.get(it.pedido_id) ?? [];
        lista.push(it);
        m.set(it.pedido_id, lista);
      }
      return m;
    },
  });
}
