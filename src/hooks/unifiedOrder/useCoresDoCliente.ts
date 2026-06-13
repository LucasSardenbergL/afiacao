import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  extrairCoresDoHistorico,
  filtrarCores,
  type CorDoCliente,
  type PedidoHistorico,
} from '@/lib/tint/cores-do-cliente';

/**
 * Cores já pedidas pelo cliente selecionado no wizard ("🎨 Cores do cliente").
 * Lê os pedidos do cliente (colunas mínimas + items jsonb, onde o sync/backfill
 * grava `tint_nome_cor`) e agrupa/filtra via helpers puros. Cliente sem conta
 * local (customerUserId null) → desabilitado (sem histórico pra ler).
 */
export function useCoresDoCliente(customerUserId: string | null | undefined) {
  const [busca, setBusca] = useState('');

  const { data: cores = [], isLoading } = useQuery<CorDoCliente[]>({
    queryKey: ['cores-do-cliente', customerUserId],
    enabled: !!customerUserId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // Pedidos do cliente são poucas dezenas; trazemos as linhas mais recentes
      // e filtramos cor em memória (cap defensivo bem acima do caso real).
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, omie_pedido_id, omie_numero_pedido, created_at, account, items')
        .eq('customer_user_id', customerUserId!)
        .order('created_at', { ascending: false })
        .limit(400);
      if (error) throw error;
      return extrairCoresDoHistorico((data ?? []) as PedidoHistorico[]);
    },
  });

  const coresFiltradas = useMemo(() => filtrarCores(cores, busca), [cores, busca]);

  return { cores, coresFiltradas, busca, setBusca, isLoading };
}
