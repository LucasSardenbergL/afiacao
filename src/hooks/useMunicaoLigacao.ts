import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { derivarMunicao, type Municao } from '@/lib/call/municao';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';

const PEDIDOS_DA_MUNICAO = 8;

/**
 * Munição READ-ONLY do co-piloto de ligação.
 * Retorna: dias desde última compra, última compra, ticket médio dos últimos 8 pedidos válidos.
 *
 * MANDATO: NUNCA chama selectCustomer (cria cadastro no Omie) nem monta catálogo.
 * O universo de VENDA vai na query (`STATUS_NAO_VENDA` + deleted_at, a autoridade), antes do
 * limit: os 8 que chegam são os 8 pedidos válidos mais recentes. Antes a lista era uma cópia
 * (sem `pendente`) aplicada em memória sobre 16 linhas, com a margem como esperança.
 */
export function useMunicaoLigacao(
  customerUserId: string | null,
): { municao: Municao | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['municao-ligacao', customerUserId],
    enabled: !!customerUserId,
    staleTime: 60_000,
    queryFn: async (): Promise<Municao> => {
      // Os 8 pedidos de VENDA mais recentes: o universo vai na query, antes do limit.
      const { data: pedidos, error } = await supabase
        .from('sales_orders')
        .select('order_date_kpi, created_at, total')
        .eq('customer_user_id', customerUserId!)
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(PEDIDOS_DA_MUNICAO);

      if (error) throw error;

      const validos = pedidos ?? [];

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
