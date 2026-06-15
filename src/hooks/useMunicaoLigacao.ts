import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { derivarMunicao, type Municao } from '@/lib/call/municao';

/** Status que NÃO representam venda concluída — excluídos da munição. */
const STATUS_INVALIDOS = new Set(['rascunho', 'orcamento', 'cancelado', 'cancelado_humano']);

/**
 * Munição READ-ONLY do co-piloto de ligação.
 * Retorna: dias desde última compra, última compra, ticket médio dos últimos 8 pedidos válidos.
 *
 * MANDATO: NUNCA chama selectCustomer (cria cadastro no Omie) nem monta catálogo.
 * Filtragem de status inválidos feita no client (padrão do projeto) para evitar
 * sintaxe PostgREST .not('status','in',...) que não é utilizada em nenhum outro
 * lugar do codebase e pode ser frágil com alguns PostgREST versions.
 */
export function useMunicaoLigacao(
  customerUserId: string | null,
): { municao: Municao | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['municao-ligacao', customerUserId],
    enabled: !!customerUserId,
    staleTime: 60_000,
    queryFn: async (): Promise<Municao> => {
      // Busca os últimos pedidos do cliente (limite generoso — filtramos inválidos depois)
      const { data: pedidos, error } = await supabase
        .from('sales_orders')
        .select('order_date_kpi, created_at, total, status')
        .eq('customer_user_id', customerUserId!)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(16); // 16 para ter margem ao excluir os inválidos e chegar em ~8 válidos

      if (error) throw error;

      // Filtrar status inválidos no client (padrão do projeto — ver useAdminCustomers/useCustomerOrders)
      const validos = (pedidos ?? [])
        .filter((p) => !STATUS_INVALIDOS.has(p.status as string))
        .slice(0, 8); // limita a 8 pedidos válidos mais recentes

      return derivarMunicao({
        pedidos: validos.map((p) => ({
          // order_date_kpi é a data do pedido no Omie; fallback em created_at para pedidos antigos
          data: (p.order_date_kpi as string | null) ?? (p.created_at as string),
          valor: Number(p.total ?? 0),
        })),
        agora: new Date(),
      });
    },
  });

  return { municao: data ?? null, loading: isLoading };
}
