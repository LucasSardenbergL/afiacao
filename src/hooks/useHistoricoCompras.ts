import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { derivarHistorico, type Historico, type HistoricoItemInput, type HistoricoPedidoInput } from '@/lib/call/historico';

/** Status que NÃO representam venda concluída (espelha useMunicaoLigacao). */
const STATUS_INVALIDOS = new Set(['rascunho', 'orcamento', 'cancelado', 'cancelado_humano']);
const MAX_PEDIDOS = 50;

interface PedidoRow { id: string; order_date_kpi: string | null; created_at: string; total: number | null; status: string | null; }
interface ItemRow { sales_order_id: string; omie_codigo_produto: number | null; quantity: number | null; unit_price: number | null; }
interface ProdutoRow { omie_codigo_produto: number; descricao: string | null; }

/**
 * Ficha pré-contato READ-ONLY: histórico de compras + preço praticado.
 * Lazy (só dispara com customerUserId). 3 queries fixas, sem N+1.
 * MANDATO: nunca escreve / nunca cria cadastro.
 */
export function useHistoricoCompras(customerUserId: string | null): { historico: Historico | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['historico-compras', customerUserId],
    enabled: !!customerUserId,
    staleTime: 60_000,
    queryFn: async (): Promise<Historico> => {
      // 1) pedidos válidos do cliente (status inválido filtrado no client — padrão do projeto)
      const { data: pedidosRaw, error: e1 } = await supabase
        .from('sales_orders')
        .select('id, order_date_kpi, created_at, total, status')
        .eq('customer_user_id', customerUserId!)
        .is('deleted_at', null)
        .order('order_date_kpi', { ascending: false, nullsFirst: false })
        .limit(MAX_PEDIDOS);
      if (e1) throw e1;
      const pedidos = ((pedidosRaw ?? []) as PedidoRow[]).filter((p) => !STATUS_INVALIDOS.has(p.status ?? ''));
      if (pedidos.length === 0) return { topProdutos: [], ultimosPedidos: [] };

      const dataDoPedido = new Map(pedidos.map((p) => [p.id, p.order_date_kpi ?? p.created_at]));
      const ids = pedidos.map((p) => p.id);

      // 2) itens desses pedidos (.limit guard contra o cap silencioso de 1000 do PostgREST)
      const { data: itensRaw, error: e2 } = await supabase
        .from('order_items')
        .select('sales_order_id, omie_codigo_produto, quantity, unit_price')
        .in('sales_order_id', ids)
        .limit(1000);
      if (e2) throw e2;
      const itensRows = ((itensRaw ?? []) as ItemRow[]).filter((r) => r.omie_codigo_produto != null);

      // 3) nomes dos produtos (omie_codigo_produto é único em omie_products → por código só)
      const codigos = [...new Set(itensRows.map((r) => r.omie_codigo_produto as number))];
      const nomePorCodigo = new Map<number, string>();
      if (codigos.length > 0) {
        const { data: prodRaw, error: e3 } = await supabase
          .from('omie_products')
          .select('omie_codigo_produto, descricao')
          .in('omie_codigo_produto', codigos);
        if (e3) throw e3;
        for (const p of (prodRaw ?? []) as ProdutoRow[]) {
          if (p.descricao) nomePorCodigo.set(p.omie_codigo_produto, p.descricao);
        }
      }

      const itens: HistoricoItemInput[] = itensRows.map((r) => ({
        codigo: r.omie_codigo_produto as number,
        nome: nomePorCodigo.get(r.omie_codigo_produto as number) ?? `Cód. ${r.omie_codigo_produto}`,
        quantidade: Number(r.quantity ?? 0),
        precoUnit: Number(r.unit_price ?? 0),
        dataPedido: dataDoPedido.get(r.sales_order_id) ?? '',
      }));

      const nItensPorPedido = new Map<string, number>();
      for (const r of itensRows) nItensPorPedido.set(r.sales_order_id, (nItensPorPedido.get(r.sales_order_id) ?? 0) + 1);

      const pedidosInput: HistoricoPedidoInput[] = pedidos.map((p) => ({
        data: p.order_date_kpi ?? p.created_at,
        valor: Number(p.total ?? 0),
        nItens: nItensPorPedido.get(p.id) ?? 0,
      }));

      return derivarHistorico({ itens, pedidos: pedidosInput, agora: new Date() });
    },
  });

  return { historico: data ?? null, loading: isLoading };
}
