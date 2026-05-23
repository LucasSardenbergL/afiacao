import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function useCustomerCore(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-core', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, email, phone, document, customer_type, cnae, requires_po, created_at, avatar_url, is_approved')
        .eq('user_id', customerId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useCustomerAddress(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-address', customerId],
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('addresses')
        .select('label, street, number, complement, neighborhood, city, state, zip_code, is_default')
        .eq('user_id', customerId!)
        .order('is_default', { ascending: false });
      return data ?? [];
    },
  });
}

export function useCustomerMetrics(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-metrics', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('customer_metrics_mv')
        .select('faturamento_90d, faturamento_prev_90d, ticket_medio_90d, pedidos_90d, dias_desde_ultima_compra, intervalo_medio_dias, ultima_compra_data, is_cold_start')
        .eq('customer_user_id', customerId!)
        .maybeSingle();
      return data;
    },
  });
}

export function useCustomerScore(customerId: string | undefined, farmerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-score', customerId, farmerId],
    enabled: !!customerId && !!farmerId,
    staleTime: 60_000,
    queryFn: async () => {
      // Tenta o score do farmer atual primeiro; cai pra qualquer score se não existir
      const { data: own } = await supabase
        .from('farmer_client_scores')
        .select('health_score, health_class, churn_risk, expansion_score, priority_score, gross_margin_pct, avg_monthly_spend_180d, days_since_last_purchase, category_count, avg_repurchase_interval, revenue_potential')
        .eq('customer_user_id', customerId!)
        .eq('farmer_id', farmerId!)
        .maybeSingle();
      if (own) return own;
      const { data: fallback } = await supabase
        .from('farmer_client_scores')
        .select('health_score, health_class, churn_risk, expansion_score, priority_score, gross_margin_pct, avg_monthly_spend_180d, days_since_last_purchase, category_count, avg_repurchase_interval, revenue_potential')
        .eq('customer_user_id', customerId!)
        .limit(1)
        .maybeSingle();
      return fallback;
    },
  });
}

/** Itens preferidos via Omie (precisa do código Omie do cliente). */
export function useCustomerPreferredItems(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-preferred', customerId],
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: link } = await supabase
        .from('omie_clientes')
        .select('omie_codigo_cliente')
        .eq('user_id', customerId!)
        .maybeSingle();
      if (!link?.omie_codigo_cliente) return [];
      const { data } = await supabase
        .from('customer_preferred_items')
        .select('product_codigo, product_descricao, familia, order_count, last_ordered_at, account')
        .eq('omie_codigo_cliente', link.omie_codigo_cliente)
        .order('last_ordered_at', { ascending: false, nullsFirst: false })
        .limit(10);
      return data ?? [];
    },
  });
}

/** Pedidos pra computar faturamento lifetime + 12m (cliente médio: poucos pedidos, OK no client). */
export function useCustomerOrders(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-orders', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('sales_orders')
        .select('id, total, created_at, status, omie_numero_pedido, account')
        .eq('customer_user_id', customerId!)
        .order('created_at', { ascending: false })
        .limit(200);
      return data ?? [];
    },
  });
}

/** Timeline de contato: calls + mensagens, unificado e ordenado. */
export function useCustomerInteractions(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-interactions', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async () => {
      const [calls, messages] = await Promise.all([
        supabase
          .from('farmer_calls')
          .select('id, started_at, call_type, call_result, is_whatsapp, notes, duration_seconds, revenue_generated, linked_sales_order_id, farmer_id')
          .eq('customer_user_id', customerId!)
          .order('started_at', { ascending: false })
          .limit(15),
        supabase
          .from('order_messages')
          .select('id, created_at, message, is_staff, sender_id, order_id')
          .in(
            'order_id',
            // janela pequena: últimas 10 ordens deste cliente
            (await supabase
              .from('orders')
              .select('id')
              .eq('user_id', customerId!)
              .order('created_at', { ascending: false })
              .limit(10)).data?.map((o) => o.id) ?? [],
          )
          .order('created_at', { ascending: false })
          .limit(15),
      ]);

      type Item =
        | { kind: 'call'; at: string; title: string; subtitle: string; tone: string; revenue?: number | null }
        | { kind: 'message'; at: string; title: string; subtitle: string; tone: string };

      const items: Item[] = [];
      (calls.data ?? []).forEach((c) => {
        items.push({
          kind: 'call',
          at: c.started_at,
          title: c.is_whatsapp ? 'WhatsApp enviado' : 'Ligação',
          subtitle: [c.call_result, c.notes].filter(Boolean).join(' · ').slice(0, 140) || c.call_type,
          tone: c.call_result === 'contato_sucesso'
            ? 'text-status-success-bold'
            : c.call_result === 'sem_resposta'
              ? 'text-muted-foreground'
              : 'text-foreground',
          revenue: c.revenue_generated,
        });
      });
      (messages.data ?? []).forEach((m) => {
        items.push({
          kind: 'message',
          at: m.created_at,
          title: m.is_staff ? 'Mensagem da equipe' : 'Mensagem do cliente',
          subtitle: m.message?.slice(0, 140) ?? '',
          tone: m.is_staff ? 'text-foreground' : 'text-status-info-bold',
        });
      });
      return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20);
    },
  });
}
