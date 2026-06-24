import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { canalToKind, canalToLabel, canalToTone, type CanalInteracao } from '@/lib/carteira/interacoes';

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
        .select('health_score, health_class, churn_risk, expansion_score, priority_score, gross_margin_pct, avg_monthly_spend_180d, days_since_last_purchase, category_count, avg_repurchase_interval, revenue_potential, sales_history_status')
        .eq('customer_user_id', customerId!)
        .eq('farmer_id', farmerId!)
        .maybeSingle();
      if (own) return own;
      const { data: fallback } = await supabase
        .from('farmer_client_scores')
        .select('health_score, health_class, churn_risk, expansion_score, priority_score, gross_margin_pct, avg_monthly_spend_180d, days_since_last_purchase, category_count, avg_repurchase_interval, revenue_potential, sales_history_status')
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
        .select('product_codigo, product_descricao, familia, order_count, last_ordered_at, account, omie_codigo_produto')
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

/** Timeline de contato unificada (ligações, WhatsApp, visitas, tarefas e mensagens de
 *  pedido) via a view canônica v_cliente_interacoes — o gate de carteira é aplicado no
 *  banco (security_invoker + carteira_visivel_para). 1 query no lugar de N. */
export function useCustomerInteractions(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-interactions', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async () => {
      // v_cliente_interacoes ainda não consta nos tipos gerados do Supabase → cast pontual
      // + .returns(). TODO(tipos): remover o `as never` após regenerar types.ts.
      const { data, error } = await supabase
        .from('v_cliente_interacoes' as never)
        .select('at, canal, titulo, resumo, revenue')
        .eq('customer_user_id', customerId!)
        .order('at', { ascending: false })
        .limit(30)
        .returns<
          { at: string; canal: CanalInteracao; titulo: string | null; resumo: string | null; revenue: number | null }[]
        >();
      if (error) throw error;
      return (data ?? []).map((r) => ({
        kind: canalToKind(r.canal),
        at: r.at,
        title: r.titulo ?? canalToLabel(r.canal),
        subtitle: (r.resumo ?? '').slice(0, 140),
        tone: canalToTone(r.canal),
        revenue: r.revenue,
      }));
    },
  });
}
