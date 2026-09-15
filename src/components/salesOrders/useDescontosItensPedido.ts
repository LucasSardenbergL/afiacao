// Desconto de cada item de um pedido de venda (`order_items.desconto_valor`) para o painel de
// detalhe. A leitura é a MESMA do cupom impresso (`buscarDescontosItens`), com a MESMA chave de cache:
// o hover da listagem que aquece o cupom (`prefetchDetail`, em useSalesOrders) aquece o painel.
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { buscarDescontosItens } from '@/components/sales/print/buscarDescontosItens';
import type { OrderFeedRow } from './types';

// Key compartilhada entre o painel (useQuery) e o cupom (queryClient.fetchQuery em useSalesOrders)
// — mesmo cache, sem fetch dobrado.
export const descontosItensQueryKey = (userId: string | undefined, pedidoId: string) =>
  ['order-descontos-itens', userId, pedidoId] as const;

// Só pedido de VENDA tem order_items: afiação (tabela `orders`) não pergunta. Quem monta o painel passa
// a query INTEIRA — estado junto com o dado —, para "não consegui ler" não chegar lá como "sem desconto".
export function useDescontosItensPedido(row: Pick<OrderFeedRow, 'origin' | 'id'> | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: descontosItensQueryKey(user?.id, row?.id ?? ''),
    enabled: !!row && row.origin === 'sales' && !!user,
    staleTime: 60_000,
    queryFn: () => buscarDescontosItens([row!.id]),
  });
}
