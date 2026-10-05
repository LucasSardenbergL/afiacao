import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { fetchAllPages } from '@/lib/postgrest';
import { addDias, hojeSP } from '@/lib/time/sp-day';
import { canalToKind, canalToLabel, canalToTone, type CanalInteracao } from '@/lib/carteira/interacoes';
import { LIMITE_FEED_PEDIDOS } from './format';

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
      const { data, error } = await supabase
        .from('customer_metrics_mv')
        .select('faturamento_90d, faturamento_prev_90d, ticket_medio_90d, pedidos_90d, dias_desde_ultima_compra, intervalo_medio_dias, ultima_compra_data, is_cold_start, calculated_at')
        .eq('customer_user_id', customerId!)
        .maybeSingle();
      // Falha LANÇA: o erro descartado virava `data` null e a faixa mostrava "R$ 0" nos tiles de 90d.
      if (error) throw error;
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

/** Itens preferidos via Omie, casados pela view fresca omie_customer_account_map_fresco (Fatia 3 do fix
 *  de rótulo + P1a staleness). A proof-table mapeia (user_id, account) -> código Omie do cliente NAQUELA
 *  conta, populada DOCUMENT-FIRST pelo sync (sem a colisão de namespace do espelho omie_clientes poluído);
 *  a view expõe só as linhas frescas (updated_at nos últimos 7d) — vínculo órfão stale não vaza.
 *  customer_preferred_items é chaveada por (omie_codigo_cliente, account) da conta de VENDA; casamos
 *  pelos PARES (código, account) do mapa, cobrindo oben E colacor. Fail-safe (precisão>recall): mapa
 *  vazio (sync ainda não populou) -> []. NÃO usa .or() cru (guard-rail CLAUDE.md): .in×.in é produto
 *  cartesiano e traria (código de uma conta × account de outra) por colisão — o filtro de pares
 *  exatos em memória descarta esses. Ver docs/superpowers/specs/2026-07-07-espelho-omie-rotulo-por-conta-design.md. */
export function useCustomerPreferredItems(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-preferred', customerId],
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PreferredItem[]> => {
      // 1. mapa (account -> código) do cliente, por conta. Lê a VIEW FRESCA (P1a): só vínculos que o sync
      //    viu no Omie nos últimos 7d (frescor no relógio do banco) — órfã stale não vaza como verdade.
      const { data: maps } = await supabase
        .from('omie_customer_account_map_fresco')
        .select('account, omie_codigo_cliente')
        .eq('user_id', customerId!);
      const pares = (maps ?? []) as Array<{ account: string; omie_codigo_cliente: number }>;
      if (pares.length === 0) return [];

      const codigos = [...new Set(pares.map((p) => p.omie_codigo_cliente))];
      const accounts = [...new Set(pares.map((p) => p.account))];
      const paresValidos = new Set(pares.map((p) => `${p.omie_codigo_cliente}::${p.account}`));

      // 2. preferred_items pelos códigos+contas do cliente; .in×.in (sem interpolar em .or()).
      const { data } = await supabase
        .from('customer_preferred_items')
        .select('product_codigo, product_descricao, familia, order_count, last_ordered_at, account, omie_codigo_produto, omie_codigo_cliente')
        .in('omie_codigo_cliente', codigos)
        .in('account', accounts)
        .order('last_ordered_at', { ascending: false, nullsFirst: false });

      // 3. filtra os PARES EXATOS (código,account) — descarta o cruzamento cartesiano cross-account.
      return ((data ?? []) as Array<PreferredItem & { omie_codigo_cliente: number }>)
        .filter((it) => paresValidos.has(`${it.omie_codigo_cliente}::${it.account}`))
        .slice(0, 10);
    },
  });
}

/**
 * "Pedidos recentes" — FEED: todo status de propósito (o card pinta o cancelado de vermelho), sem o
 * pedido apagado. NÃO é fonte de faturamento: o número vem de `useCustomerFaturamento12m`.
 */
export function useCustomerOrders(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-orders', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, total, created_at, status, omie_numero_pedido, account')
        .eq('customer_user_id', customerId!)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(LIMITE_FEED_PEDIDOS);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Janela do "Faturamento 12m", em dias — a mesma régua do tile "90d" (`customer_metrics_mv`):
 * `hoje − N ≤ order_date_kpi ≤ hoje`, com o teto em HOJE (um kpi no futuro não é faturamento passado). */
const JANELA_12M_DIAS = 365;

/** `total` é NOT NULL (default 0) em `sales_orders`. */
type LinhaFaturamento = { total: number };

/**
 * Faturamento dos últimos 12 meses no universo de VENDA da autoridade, datado por `order_date_kpi` —
 * o mesmo universo e o mesmo eixo do tile "90d" ao lado. Antes ele saía da lista de pedidos recentes:
 * todo status (R$ 34,8 mil a mais em 19 clientes) e um `limit(200)` por `created_at` que escondia
 * 55–72% do faturamento dos 3 maiores clientes (2026-10-01). Paginado SEM teto; a falha LANÇA — a
 * tela mostra "indisponível", nunca R$ 0.
 *
 * ⚠️ LIMITE CONHECIDO (Codex, adversarial de 2026-10-05): paginar por offset não tira um retrato. Uma
 * venda que entra ENTRE duas requisições, com `id` antes da fronteira, faz a página seguinte reler a
 * última linha da anterior — a soma sai com sucesso e com uma linha a mais. Só existe com mais de
 * 1.000 pedidos do cliente na janela; o máximo medido é 710 (2026-10-05), ou seja, 1 página e 1
 * requisição. Se um cliente passar de 1.000, o retrato consistente é agregar no banco (`SUM`/`COUNT`
 * numa consulta só), não paginar.
 */
export function useCustomerFaturamento12m(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-faturamento-12m', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async () => {
      const hoje = hojeSP();
      const desde = addDias(hoje, -JANELA_12M_DIAS);
      const linhas = await fetchAllPages<LinhaFaturamento>(
        (de, ate) =>
          supabase
            .from('sales_orders')
            .select('total')
            .eq('customer_user_id', customerId!)
            .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
            .is('deleted_at', null)
            .gte('order_date_kpi', desde)
            .lte('order_date_kpi', hoje)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: LinhaFaturamento[] | null; error: unknown }>,
        'sales_orders/c360-faturamento-12m',
      );
      return {
        total: linhas.reduce((s, l) => s + Number(l.total), 0),
        pedidos: linhas.length,
      };
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
