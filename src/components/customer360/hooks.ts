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

interface PreferredItem {
  product_codigo: string | null;
  product_descricao: string | null;
  familia: string | null;
  order_count: number | null;
  last_ordered_at: string | null;
  account: string | null;
  omie_codigo_produto: number;
}

/** Itens preferidos via Omie. FAIL-CLOSED enquanto a identidade Omie por conta não for resolvível
 *  (Fatia 2 do fix de rótulo — BUG de colisão de namespace). customer_preferred_items é chaveada por
 *  (omie_codigo_cliente, account) da conta de VENDA. O espelho omie_clientes rotula TUDO 'colacor' (o
 *  default que nenhum writer seta), mas é um MIX de código oben (bulk syncCustomers) + colacor_sc
 *  (writers manuais), de numeração INDEPENDENTE que colide entre contas. Casar preferred_items pelo
 *  código do espelho sem account confiável traz item de OUTRO cliente por colisão — provado via
 *  psql-ro (2026-07): filtrar account='oben' casou 100% ERRADO (~20 fichas), 'colacor' 0 match.
 *  Precisão>recall: não exibimos nada até a proof-table (omie_customer_account_map) / re-rótulo por
 *  conta (Fatia 3) casarem por (user_id, account, código). Ver
 *  docs/superpowers/specs/2026-07-07-espelho-omie-rotulo-por-conta-design.md. */
export function useCustomerPreferredItems(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-preferred', customerId],
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    queryFn: (): PreferredItem[] => [],
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
      const { data, error } = await supabase
        .from('v_cliente_interacoes')
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
