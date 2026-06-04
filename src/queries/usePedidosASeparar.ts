import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mapItemsToPickingRows } from '@/lib/picking/bridge-helpers';

// listar_pedidos_a_separar não está no types gerado → cast do client (mesmo padrão de useRegistrarContato).
type RpcClient = { rpc(fn: string, p?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };

export interface PedidoASeparar {
  id: string;
  customer_user_id: string;
  customerName: string;
  total: number;
  status: string;
  data: string | null;
  itemCount: number;
  hasFractional: boolean;
}

interface Row {
  id: string;
  customer_user_id: string;
  total: number | string | null;
  status: string;
  data: string | null;
  items: unknown;
}

/**
 * Pedidos Oben candidatos a separação (recentes, não-cancelado/rascunho/orçamento, sem task).
 * Anti-join + COALESCE de data são server-side (RPC `listar_pedidos_a_separar`); o helper puro
 * deriva contagem de itens + flag de fracionário a partir do `items` jsonb.
 */
export function usePedidosASeparar(account: string) {
  const acc = account.toLowerCase();
  return useQuery({
    queryKey: ['pk-pedidos-a-separar', acc],
    queryFn: async (): Promise<PedidoASeparar[]> => {
      const { data, error } = await (supabase as unknown as RpcClient).rpc('listar_pedidos_a_separar', { p_account: acc });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];

      // Resolve nome do cliente (profiles.user_id = customer_user_id), padrão de AgendaTodayList/useSalesOrders.
      const ids = [...new Set(rows.map((r) => r.customer_user_id).filter(Boolean))];
      const nameMap = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase.from('profiles').select('user_id, name').in('user_id', ids);
        for (const p of profs ?? []) nameMap.set(p.user_id, p.name);
      }

      return rows.map((o) => {
        const m = mapItemsToPickingRows(o.items);
        return {
          id: o.id,
          customer_user_id: o.customer_user_id,
          customerName: nameMap.get(o.customer_user_id) ?? '—',
          total: Number(o.total ?? 0),
          status: o.status,
          data: o.data,
          itemCount: m.rows.length,
          hasFractional: m.fractionalNotes.length > 0,
        };
      });
    },
    refetchInterval: 60000,
  });
}
