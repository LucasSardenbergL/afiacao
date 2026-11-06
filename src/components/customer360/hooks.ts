import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { fetchAllPages } from '@/lib/postgrest';
import { buscarMargemScore } from '@/lib/scoring/margemScores';
import { captureException } from '@/lib/analytics';
import { addDias, hojeSP } from '@/lib/time/sp-day';
import { canalToKind, canalToLabel, canalToTone, type CanalInteracao } from '@/lib/carteira/interacoes';
import { LIMITE_FEED_PEDIDOS } from './format';
import {
  agregarItensPreferidos,
  completarComCatalogo,
  JANELA_PREFERIDOS_DIAS,
  type PreferredItem,
  type ProdutoCatalogo,
} from './itens-preferidos';

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

// Sem `gross_margin_pct`: a coluna é fechada para authenticated (migration 20261014120100) e listá-la
// derruba a query inteira com 42501. A margem vem de `buscarMargemScore`.
const COLUNAS_SCORE_C360 =
  'health_score, health_class, churn_risk, expansion_score, priority_score, itens_com_custo, itens_sem_custo, avg_monthly_spend_180d, days_since_last_purchase, category_count, avg_repurchase_interval, revenue_potential, sales_history_status';

export function useCustomerScore(customerId: string | undefined, farmerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-score', customerId, farmerId],
    enabled: !!customerId && !!farmerId,
    staleTime: 60_000,
    queryFn: async () => {
      // A margem só precisa do cliente, então sai JUNTO com o score (F12, plano v7): a espera é
      // max(score, margem), não score + margem. O `.catch` fica preso na hora — a promessa nunca
      // rejeita, então não vira rejeição sem dono se a leitura do score lançar antes do `await`.
      // A margem NÃO vem da tabela: a coluna é fechada para authenticated (FU4-F) e sai pela RPC com
      // gate de projeção. `margem_oculta` separa "o servidor não concedeu" de "não apurada" — sem ele
      // o hero diria "sem compra na janela" sobre quem compra todo mês.
      // Falha da RPC NÃO derruba o score: health/churn/cobertura foram lidos e seguem na tela; só a
      // margem some (`margem_oculta`), sem legenda que afirme algo sobre o cliente (achado Codex).
      const margemP = buscarMargemScore(customerId!).catch((e: unknown) => {
        captureException(e, { fonte: 'get_scores_margem/c360' });
        return undefined;
      });
      // Score do farmer atual primeiro; o fallback (qualquer score do cliente) só roda quando a
      // leitura própria teve SUCESSO sem linha. Falha LANÇA: o erro descartado virava "Sem score"
      // na tela — ausência afirmada sobre uma leitura que não aconteceu.
      const own = await supabase
        .from('farmer_client_scores')
        .select(COLUNAS_SCORE_C360)
        .eq('customer_user_id', customerId!)
        .eq('farmer_id', farmerId!)
        .maybeSingle();
      if (own.error) throw own.error;
      let linha = own.data;
      if (!linha) {
        const fallback = await supabase
          .from('farmer_client_scores')
          .select(COLUNAS_SCORE_C360)
          .eq('customer_user_id', customerId!)
          .limit(1)
          .maybeSingle();
        if (fallback.error) throw fallback.error;
        linha = fallback.data;
      }
      // Sem linha não há onde pendurar a margem: devolve já (a RPC em voo morre sem dono e sem custo).
      if (!linha) return linha;
      const margem = await margemP;
      return {
        ...linha,
        gross_margin_pct: margem?.margem ?? null,
        margem_oculta: margem ? !margem.visivel : true,
      };
    },
  });
}

/**
 * Itens preferidos: os produtos que o cliente mais comprou nos últimos 12 meses, dos PEDIDOS DE VENDA
 * (`sales_orders`, universo de venda, por `order_date_kpi`) — ver ./itens-preferidos.ts. Antes lia
 * `customer_preferred_items`, congelada desde 08/06 (o escritor perdeu o único chamador em #682).
 * Paginado sem teto, como o faturamento ao lado; a falha LANÇA — o card mostra "não consegui ler",
 * nunca "sem itens preferidos".
 */
export function useCustomerPreferredItems(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-preferred', customerId],
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PreferredItem[]> => {
      const hoje = hojeSP();
      const desde = addDias(hoje, -JANELA_PREFERIDOS_DIAS);
      const pedidos = await fetchAllPages(
        (de, ate) =>
          supabase
            .from('sales_orders')
            .select('account, order_date_kpi, items')
            .eq('customer_user_id', customerId!)
            .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
            .is('deleted_at', null)
            .gte('order_date_kpi', desde)
            .lte('order_date_kpi', hoje)
            .order('id', { ascending: true })
            .range(de, ate),
        'sales_orders/c360-preferidos',
      );
      const itens = agregarItensPreferidos(pedidos);
      if (itens.length === 0) return [];

      // Código e família vêm do catálogo; .in×.in é produto cartesiano, e o casamento por PAR
      // (conta, produto) em completarComCatalogo descarta o cruzamento entre contas.
      const { data: catalogo, error } = await supabase
        .from('omie_products')
        .select('account, omie_codigo_produto, codigo, familia')
        .in('omie_codigo_produto', [...new Set(itens.map((it) => it.omie_codigo_produto))])
        .in('account', [...new Set(itens.map((it) => it.account).filter((a): a is string => a !== null))]);
      if (error) throw error;
      return completarComCatalogo(itens, (catalogo ?? []) as ProdutoCatalogo[]);
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
      const linhas = await fetchAllPages(
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
            .range(de, ate),
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
