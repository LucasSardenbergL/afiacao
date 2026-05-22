import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow, parseISO, subMonths } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  ArrowLeft,
  Building2,
  Phone,
  Mail,
  MapPin,
  TrendingUp,
  Calendar,
  Package,
  MessageSquare,
  PhoneCall,
  Activity,
  ShoppingBag,
  Clock,
  AlertCircle,
  Heart,
  User,
  Inbox,
  Users,
  Star,
  Award,
  Cake,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { CallButton } from '@/components/call/CallButton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useCustomerContacts } from '@/hooks/useCustomerContacts';
import { CARGO_LABEL } from '@/lib/customer-contact/types';

/**
 * Customer 360 — dashboard executivo do cliente.
 *
 * Mostra de relance o que importa pra decidir o próximo passo comercial:
 *  - Identidade + saúde (health/margem/churn)
 *  - Pulso financeiro (12m, ticket, dias desde última compra)
 *  - Itens preferidos (o que ele compra de verdade)
 *  - Último contato (calls + WhatsApp) — abre o caminho pra agir
 *
 * Schema usado:
 *  profiles, addresses, omie_clientes, customer_metrics_mv, farmer_client_scores,
 *  customer_preferred_items, sales_orders, farmer_calls.
 *
 * Filosofia de UX: densidade alta (B2B operacional), KPI em mono pra leitura tabular,
 * cards quase-neutros, status só onde a cor agrega informação (saúde, churn).
 */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return BRL.format(v);
}

function formatPctMaybe(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  // Schema: gross_margin_pct vem como número (ex: 0.32 ou 32 — normalizamos)
  const pct = v > 1 ? v : v * 100;
  // Zero sem decimal ("0%" em vez de "0.0%"); outros valores com 1 decimal só se houver fração.
  if (pct === 0) return '0%';
  const rounded = Math.round(pct);
  return Math.abs(pct - rounded) < 0.05 ? `${rounded}%` : `${pct.toFixed(1)}%`;
}

/**
 * Profiles tem campo `email` text livre. Sincronização do Omie costuma concatenar
 * múltiplos emails com vírgula (ex: "compras@x.com,financeiro@x.com"). Quebra em
 * lista pra renderizar separadamente.
 */
function splitEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0 && e.includes('@'));
}

/**
 * `profiles.customer_type` vem como enum-ish text do app/Omie. Mapeia pros rótulos
 * que o usuário humano entende. Fallback: capitaliza o valor cru.
 */
function formatCustomerType(t: string | null | undefined): string {
  if (!t) return '—';
  const map: Record<string, string> = {
    domestic: 'Doméstico',
    residential: 'Residencial',
    residencial: 'Residencial',
    commercial: 'Comercial',
    comercial: 'Comercial',
    industrial: 'Industrial',
    revenda: 'Revenda',
    reseller: 'Revenda',
    professional: 'Profissional',
    profissional: 'Profissional',
  };
  return map[t.toLowerCase()] ?? (t.charAt(0).toUpperCase() + t.slice(1));
}

/** Tom semântico pro badge de status do pedido. Mapeia status string pra cor sutil. */
function orderStatusTone(status: string): { className: string; label: string } {
  const s = (status || '').toLowerCase();
  if (['faturado', 'concluido', 'pago', 'entregue'].includes(s)) {
    return { className: 'bg-status-success-bg text-status-success-bold border-status-success/20', label: status };
  }
  if (['cancelado', 'recusado', 'erro'].includes(s)) {
    return { className: 'bg-status-error-bg text-status-error-bold border-status-error/20', label: status };
  }
  if (['pendente', 'aguardando', 'em_analise'].includes(s)) {
    return { className: 'bg-status-warning-bg text-status-warning-bold border-status-warning/20', label: status };
  }
  return { className: 'text-muted-foreground', label: status };
}

function formatDateOrDash(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    return format(parseISO(d), "dd 'de' MMM yyyy", { locale: ptBR });
  } catch {
    return '—';
  }
}

function formatRelative(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    return formatDistanceToNow(parseISO(d), { locale: ptBR, addSuffix: true });
  } catch {
    return '—';
  }
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function healthTone(healthClass: string | null): {
  label: string;
  className: string;
  dot: string;
} {
  switch (healthClass) {
    case 'saudavel':
      return { label: 'Saudável', className: 'text-status-success-bold', dot: 'bg-status-success' };
    case 'atencao':
      return { label: 'Atenção', className: 'text-status-warning-bold', dot: 'bg-status-warning' };
    case 'risco':
      return { label: 'Em risco', className: 'text-status-error-bold', dot: 'bg-status-error' };
    case 'critico':
      return { label: 'Crítico', className: 'text-status-error-bold', dot: 'bg-status-error' };
    default:
      return { label: 'Sem score', className: 'text-muted-foreground', dot: 'bg-muted-foreground' };
  }
}

function churnTone(risk: number | null): { label: string; className: string } {
  if (risk === null || risk === undefined) return { label: '—', className: 'text-muted-foreground' };
  const pct = risk > 1 ? risk : risk * 100;
  if (pct >= 70) return { label: `${pct.toFixed(0)}% risco churn`, className: 'text-status-error-bold' };
  if (pct >= 40) return { label: `${pct.toFixed(0)}% risco churn`, className: 'text-status-warning-bold' };
  return { label: `${pct.toFixed(0)}% risco churn`, className: 'text-status-success-bold' };
}

/* ─────────────────────────────  Hooks  ───────────────────────────── */

function useCustomerCore(customerId: string | undefined) {
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

function useCustomerAddress(customerId: string | undefined) {
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

function useCustomerMetrics(customerId: string | undefined) {
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

function useCustomerScore(customerId: string | undefined, farmerId: string | undefined) {
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
function useCustomerPreferredItems(customerId: string | undefined) {
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
function useCustomerOrders(customerId: string | undefined) {
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
function useCustomerInteractions(customerId: string | undefined) {
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

/* ──────────────────────────  KPI subcomponents  ────────────────────────── */

function KpiCard({
  label,
  value,
  hint,
  trend,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  trend?: { value: number; label: string };
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {label}
          </span>
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div className="kpi-value">{value}</div>
        {trend && (
          <div
            className={cn(
              'kpi-delta',
              trend.value > 0 ? 'text-status-success-bold' : trend.value < 0 ? 'text-status-error-bold' : 'text-muted-foreground',
            )}
          >
            {trend.value > 0 ? '↑' : trend.value < 0 ? '↓' : '·'} {Math.abs(trend.value).toFixed(0)}%
            <span className="text-muted-foreground font-normal ml-1">{trend.label}</span>
          </div>
        )}
        {hint && !trend && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────────  Page  ────────────────────────────── */

export default function Customer360() {
  const { customerId } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const core = useCustomerCore(customerId);
  const address = useCustomerAddress(customerId);
  const metrics = useCustomerMetrics(customerId);
  const score = useCustomerScore(customerId, user?.id);
  const preferred = useCustomerPreferredItems(customerId);
  const orders = useCustomerOrders(customerId);
  const interactions = useCustomerInteractions(customerId);
  // Contatos extras (PR-CONTACTS): múltiplos contatos por cliente (dono, gerente,
  // comprador, etc). Edição completa fica em /admin/customers detail tab — aqui
  // mostro só leitura compacta pra contexto operacional.
  const contacts = useCustomerContacts(customerId ?? null);

  // Lifetime + 12m derivados dos pedidos
  const revenueDerived = useMemo(() => {
    const list = orders.data ?? [];
    const lifetime = list.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const cutoff = subMonths(new Date(), 12);
    const last12 = list
      .filter((o) => parseISO(o.created_at) >= cutoff)
      .reduce((s, o) => s + Number(o.total ?? 0), 0);
    const orderCount12m = list.filter((o) => parseISO(o.created_at) >= cutoff).length;
    const lastOrder = list[0];
    return { lifetime, last12, orderCount12m, lastOrderAt: lastOrder?.created_at ?? null };
  }, [orders.data]);

  if (core.isLoading || (core.isFetching && !core.data)) {
    return <PageSkeleton variant="detail" />;
  }

  if (!core.data) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Cliente não encontrado"
        description="Pode ter sido removido ou o link está errado. Volte pra lista e tente de novo."
        tone="operational"
        actionLabel="Voltar para Clientes"
        onAction={() => navigate('/admin/customers')}
      />
    );
  }

  const customer = core.data;
  const m = metrics.data;
  const s = score.data;
  const health = healthTone(s?.health_class ?? null);
  const churn = churnTone(s?.churn_risk ?? null);
  const isPj = (customer.document ?? '').replace(/\D/g, '').length === 14;
  const fatTrend90 =
    m?.faturamento_90d && m?.faturamento_prev_90d && m.faturamento_prev_90d > 0
      ? ((m.faturamento_90d - m.faturamento_prev_90d) / m.faturamento_prev_90d) * 100
      : null;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="pb-12 space-y-6">
        {/* ─── Breadcrumb + voltar ─── */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => navigate('/admin/customers')}
          >
            <ArrowLeft className="w-3.5 h-3.5 mr-1" />
            Clientes
          </Button>
          <span>/</span>
          <span className="text-foreground">360°</span>
        </div>

        {/* ─── Hero ─── */}
        <header className="bg-cockpit-hero relative overflow-hidden rounded-lg border border-border p-6">
          <div className="noise" />
          <div className="relative flex flex-col md:flex-row md:items-start gap-4">
            <div className="w-16 h-16 rounded-full border border-border bg-muted flex items-center justify-center overflow-hidden shrink-0">
              {customer.avatar_url ? (
                <img
                  src={customer.avatar_url}
                  alt={customer.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-xl font-semibold tracking-tight text-foreground">
                  {initials(customer.name)}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Nome do cliente: line-clamp-2 em vez de truncate, p/ acomodar razao
                    social longa em viewport estreito (Lovable preview split, mobile).
                    Em viewport wide cabe em 1 linha; em estreito quebra sem truncar. */}
                <h1 className="font-display text-3xl font-medium tracking-[-0.04em] leading-tight line-clamp-2 break-words min-w-0">
                  {customer.name}
                </h1>
                {isPj && (
                  <Badge variant="outline" className="font-tabular text-[10px] uppercase">
                    <Building2 className="w-3 h-3 mr-1" />
                    PJ
                  </Badge>
                )}
                {!isPj && customer.document && (
                  <Badge variant="outline" className="font-tabular text-[10px] uppercase">
                    PF
                  </Badge>
                )}
                {customer.requires_po && (
                  <Badge variant="outline" className="text-[10px] uppercase">
                    Exige PO
                  </Badge>
                )}
              </div>
              <div className="mt-1 flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
                {customer.document && (
                  <span className="font-tabular">{formatDocument(customer.document)}</span>
                )}
                {customer.cnae && (
                  <Tooltip>
                    <TooltipTrigger>
                      <span className="font-tabular cursor-help">CNAE {customer.cnae}</span>
                    </TooltipTrigger>
                    <TooltipContent>Atividade econômica principal (CNAE)</TooltipContent>
                  </Tooltip>
                )}
                <span>·</span>
                <span>Cliente desde {formatDateOrDash(customer.created_at)}</span>
              </div>
              {/* Status chips — peso visual maior que texto solto, p/ o estado do cliente
                  competir com o CTA "Novo pedido". Cliente crítico precisa puxar o olho. */}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                    s?.health_class === 'critico' || s?.health_class === 'risco'
                      ? 'bg-status-error-bg text-status-error-bold border-status-error/20'
                      : s?.health_class === 'atencao'
                        ? 'bg-status-warning-bg text-status-warning-bold border-status-warning/20'
                        : s?.health_class === 'saudavel'
                          ? 'bg-status-success-bg text-status-success-bold border-status-success/20'
                          : 'bg-muted text-muted-foreground border-border',
                  )}
                >
                  <span className={cn('inline-block w-1.5 h-1.5 rounded-full', health.dot)} />
                  {health.label}
                </span>
                {s?.churn_risk != null && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                      churn.className.replace('text-', 'border-').replace('-bold', '/20'),
                      churn.className,
                    )}
                  >
                    <AlertCircle className="w-3 h-3" />
                    {churn.label}
                  </span>
                )}
                {s?.gross_margin_pct != null && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
                      s.gross_margin_pct >= 0.3
                        ? 'bg-status-success-bg text-status-success-bold border-status-success/20'
                        : s.gross_margin_pct >= 0.15
                          ? 'bg-status-warning-bg text-status-warning-bold border-status-warning/20'
                          : 'bg-status-error-bg text-status-error-bold border-status-error/20',
                    )}
                  >
                    <Activity className="w-3 h-3" />
                    {formatPctMaybe(s.gross_margin_pct)} margem
                  </span>
                )}
              </div>
            </div>
            {/* Ações rápidas */}
            <div className="flex flex-wrap gap-2">
              {customer.phone && (
                <CallButton phone={customer.phone} customerName={customer.name} />
              )}
              {customer.phone && (
                <Button asChild variant="outline" size="sm">
                  <a
                    href={`https://wa.me/${customer.phone.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                    WhatsApp
                  </a>
                </Button>
              )}
              <Button asChild size="sm">
                <Link to={`/admin/orders/new?customer=${customer.user_id}`}>
                  <ShoppingBag className="w-3.5 h-3.5 mr-1.5" />
                  Novo pedido
                </Link>
              </Button>
            </div>
          </div>
        </header>

        {/* ─── KPI Strip ─── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Faturamento 12m"
            value={formatBRL(revenueDerived.last12)}
            hint={`${revenueDerived.orderCount12m} pedidos`}
            icon={TrendingUp}
          />
          <KpiCard
            label="Faturamento 90d"
            value={formatBRL(m?.faturamento_90d ?? 0)}
            trend={
              fatTrend90 !== null
                ? { value: fatTrend90, label: 'vs. 90d anteriores' }
                : undefined
            }
            hint={fatTrend90 === null ? `${m?.pedidos_90d ?? 0} pedidos` : undefined}
            icon={Calendar}
          />
          <KpiCard
            label="Ticket médio (90d)"
            value={formatBRL(m?.ticket_medio_90d ?? 0)}
            hint={s?.avg_repurchase_interval ? `Recompra ~${Math.round(s.avg_repurchase_interval)}d` : undefined}
            icon={ShoppingBag}
          />
          <KpiCard
            label="Última compra"
            value={
              m?.dias_desde_ultima_compra != null
                ? `${m.dias_desde_ultima_compra}d`
                : revenueDerived.lastOrderAt
                  ? formatRelative(revenueDerived.lastOrderAt)
                  : 'Nunca'
            }
            hint={
              m?.intervalo_medio_dias
                ? `Intervalo médio ~${Math.round(m.intervalo_medio_dias)}d`
                : revenueDerived.lastOrderAt
                  ? formatDateOrDash(revenueDerived.lastOrderAt)
                  : undefined
            }
            icon={Clock}
          />
        </div>

        {/* ─── Grid principal ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Coluna esquerda: identidade */}
          <div className="lg:col-span-1 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  Contato
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-sm">
                {/* F1: profile.email frequentemente vem concatenado por vírgula vindo do Omie.
                    Split + render como lista. Cada email vira `mailto:` clicável. */}
                {(() => {
                  const emails = splitEmails(customer.email);
                  if (emails.length === 0) {
                    return <DataRow icon={Mail} label="E-mail" value={null} />;
                  }
                  if (emails.length === 1) {
                    return (
                      <DataRow
                        icon={Mail}
                        label="E-mail"
                        value={emails[0]}
                        href={`mailto:${emails[0]}`}
                      />
                    );
                  }
                  return (
                    <div className="flex items-start gap-3">
                      <Mail className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-muted-foreground">
                          E-mails <span className="font-tabular">({emails.length})</span>
                        </div>
                        <ul className="space-y-0.5 mt-0.5">
                          {emails.map((e) => (
                            <li key={e}>
                              <a
                                href={`mailto:${e}`}
                                className="text-sm text-foreground hover:underline truncate block"
                              >
                                {e}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  );
                })()}
                <DataRow
                  icon={Phone}
                  label="Telefone"
                  value={customer.phone ? formatPhone(customer.phone) : null}
                />
                {/* F9: icon contextual ao tipo (PJ vs PF) em vez de Sparkles decorativo.
                    F3: customer_type traduzido pra rótulo humano. */}
                <DataRow
                  icon={isPj ? Building2 : User}
                  label="Tipo"
                  value={formatCustomerType(customer.customer_type) || (isPj ? 'PJ' : 'PF')}
                />
              </CardContent>
            </Card>

            {/* Contatos extras (PR-CONTACTS) — dono, gerente, comprador, etc.
                Edição completa em /admin/customers detail. Aqui é leitura compacta. */}
            <Card>
              <CardHeader className="pb-3 flex flex-row items-center gap-2 space-y-0">
                <Users className="w-4 h-4 text-muted-foreground" />
                <CardTitle className="text-sm font-medium flex-1">
                  Contatos extras
                </CardTitle>
                <Badge variant="outline" className="text-[10px] uppercase font-tabular">
                  {contacts.data?.length ?? 0}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2.5 text-sm">
                {contacts.isLoading ? (
                  <div className="space-y-2">
                    {[1, 2].map((i) => (
                      <div key={i} className="h-10 bg-muted/40 rounded animate-pulse" />
                    ))}
                  </div>
                ) : contacts.data && contacts.data.length > 0 ? (
                  <>
                    <ul className="space-y-2.5 divide-y divide-border -my-1">
                      {contacts.data.slice(0, 5).map((c) => (
                        <ContactRow key={c.id} contact={c} />
                      ))}
                    </ul>
                    <Separator className="my-2" />
                    <div className="text-right">
                      <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                        <Link to={`/admin/customers/${customerId}`}>
                          Gerenciar contatos
                        </Link>
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-4 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Nenhum contato extra cadastrado.
                    </p>
                    <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                      <Link to={`/admin/customers/${customerId}`}>
                        Adicionar contato
                      </Link>
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-muted-foreground" />
                  Endereço
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {address.data && address.data.length > 0 ? (
                  address.data.slice(0, 2).map((a, i) => {
                    // F2: "OMIE" e "padrão" são labels técnicos do ERP. Pro usuário, o que
                    // importa é se é o endereço padrão ou não. Se for padrão, mostra "Principal".
                    // Caso contrário, usa label custom OU "Endereço N" como fallback.
                    const isFirstShown = i === 0;
                    const isOmieLabel = (a.label ?? '').toUpperCase() === 'OMIE';
                    const displayLabel = a.is_default
                      ? 'Principal'
                      : isOmieLabel
                        ? `Endereço ${i + 1}`
                        : (a.label || `Endereço ${i + 1}`);
                    return (
                      <div key={i} className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {displayLabel}
                          </span>
                          {a.is_default && !isFirstShown && (
                            <Badge variant="outline" className="text-[9px] uppercase">
                              Padrão
                            </Badge>
                          )}
                        </div>
                        <div className="text-foreground leading-snug">
                          {a.street}, {a.number}
                          {a.complement && <span className="text-muted-foreground"> · {a.complement}</span>}
                        </div>
                        <div className="text-muted-foreground">
                          {a.neighborhood} · {a.city}/{a.state} · {formatCep(a.zip_code)}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-sm text-muted-foreground">Nenhum endereço cadastrado.</p>
                )}
              </CardContent>
            </Card>

            {s && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Heart className="w-4 h-4 text-muted-foreground" />
                    Score comercial
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2.5 text-sm">
                  {/* F8: layout label-esquerda / valor-direita em mono, p/ valores
                      numéricos saltarem na varredura. Score é dado denso, não prosa. */}
                  <ScoreRow
                    label="Prioridade"
                    value={s.priority_score != null ? Math.round(s.priority_score).toString() : '—'}
                    hint="0–100"
                  />
                  <ScoreRow
                    label="Expansão"
                    value={s.expansion_score != null ? Math.round(s.expansion_score).toString() : '—'}
                    hint="potencial"
                  />
                  <ScoreRow
                    label="Receita potencial"
                    value={s.revenue_potential != null ? formatBRL(s.revenue_potential) : '—'}
                  />
                  <ScoreRow
                    label="Gasto mensal (180d)"
                    value={s.avg_monthly_spend_180d != null ? formatBRL(s.avg_monthly_spend_180d) : '—'}
                  />
                  <ScoreRow
                    label="Categorias compradas"
                    value={s.category_count != null ? String(s.category_count) : '—'}
                  />
                </CardContent>
              </Card>
            )}
          </div>

          {/* Coluna direita: itens + timeline */}
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Package className="w-4 h-4 text-muted-foreground" />
                  Itens preferidos
                  <Badge variant="outline" className="ml-auto text-[10px] uppercase font-tabular">
                    {preferred.data?.length ?? 0}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {preferred.isLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-10 bg-muted/40 rounded animate-pulse" />
                    ))}
                  </div>
                ) : preferred.data && preferred.data.length > 0 ? (
                  <ul className="divide-y divide-border -my-2">
                    {preferred.data.map((it) => (
                      <li key={`${it.product_codigo}-${it.account}`} className="py-2.5 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {it.product_descricao ?? `Produto ${it.product_codigo}`}
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                            <span className="font-tabular">{it.product_codigo}</span>
                            {it.familia && (
                              <>
                                <span>·</span>
                                <span>{it.familia}</span>
                              </>
                            )}
                            {it.account && (
                              <>
                                <span>·</span>
                                <span className="uppercase tracking-wide">{it.account}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-mono">{it.order_count ?? 0}x</div>
                          <div className="text-xs text-muted-foreground">
                            {it.last_ordered_at ? formatRelative(it.last_ordered_at) : '—'}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    icon={Package}
                    title="Sem itens preferidos ainda"
                    description="Aparecerão depois das primeiras compras."
                    tone="operational"
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <PhoneCall className="w-4 h-4 text-muted-foreground" />
                  Últimos contatos
                  <Badge variant="outline" className="ml-auto text-[10px] uppercase font-tabular">
                    {interactions.data?.length ?? 0}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {interactions.isLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-12 bg-muted/40 rounded animate-pulse" />
                    ))}
                  </div>
                ) : interactions.data && interactions.data.length > 0 ? (
                  <ul className="space-y-2.5">
                    {interactions.data.map((it, i) => (
                      <li key={i} className="flex items-start gap-3 text-sm">
                        <span
                          className={cn(
                            'inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted shrink-0',
                            it.tone,
                          )}
                        >
                          {it.kind === 'call' ? (
                            <PhoneCall className="w-3 h-3" />
                          ) : (
                            <MessageSquare className="w-3 h-3" />
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{it.title}</span>
                            <span className="text-xs text-muted-foreground">·</span>
                            <span className="text-xs text-muted-foreground">
                              {formatRelative(it.at)}
                            </span>
                            {it.kind === 'call' && it.revenue != null && it.revenue > 0 && (
                              <Badge className="text-[9px] uppercase bg-status-success-bg text-status-success-bold hover:bg-status-success-bg">
                                +{formatBRL(it.revenue)}
                              </Badge>
                            )}
                          </div>
                          {it.subtitle && (
                            <p className="text-xs text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                              {it.subtitle}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    icon={Inbox}
                    title="Sem contatos recentes"
                    description="Nenhuma ligação ou mensagem registrada nas últimas semanas."
                    tone="operational"
                  />
                )}
              </CardContent>
            </Card>

            {/* Pedidos recentes resumido */}
            {orders.data && orders.data.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <ShoppingBag className="w-4 h-4 text-muted-foreground" />
                    Pedidos recentes
                    <Badge variant="outline" className="ml-auto text-[10px] uppercase font-tabular">
                      {orders.data.length}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y divide-border -my-2">
                    {orders.data.slice(0, 5).map((o) => {
                      // F11: badge de status com tom semântico (verde p/ faturado, vermelho
                      // p/ cancelado, âmbar p/ pendente). Cinza só se status não mapeado.
                      const tone = orderStatusTone(o.status);
                      return (
                        <li key={o.id} className="py-2 flex items-center gap-3 text-sm">
                          <div className="flex-1 min-w-0">
                            <div className="font-tabular text-foreground">
                              PV {o.omie_numero_pedido ?? o.id.slice(0, 8)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {formatDateOrDash(o.created_at)} ·{' '}
                              <span className="uppercase tracking-wide">{o.account}</span>
                            </div>
                          </div>
                          <div className="text-sm font-mono tabular-nums">{formatBRL(o.total)}</div>
                          <Badge
                            variant="outline"
                            className={cn('text-[10px] uppercase font-tabular', tone.className)}
                          >
                            {tone.label}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                  {orders.data.length > 5 && (
                    <>
                      <Separator className="my-3" />
                      <div className="text-right">
                        <Button
                          asChild
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7"
                        >
                          <Link to={`/sales?customer=${customer.user_id}`}>
                            Ver todos ({orders.data.length})
                          </Link>
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

/* ───────────────────  helpers UI  ─────────────────── */

function DataRow({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null | undefined;
  hint?: string;
  href?: string;
}) {
  const display = value ?? '—';
  return (
    <div className="flex items-start gap-3">
      {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        {href && value ? (
          <a href={href} className="text-sm text-foreground hover:underline truncate block">
            {display}
          </a>
        ) : (
          <div className="text-sm text-foreground truncate">{display}</div>
        )}
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * Linha compacta de contato extra (dono / gerente / comprador / etc).
 * Mostra nome + cargo, telefone clicável + WhatsApp, badges (primary, decisão,
 * só WhatsApp, aniversário). Edição completa fica em /admin/customers detail
 * tab — aqui é só leitura pra contexto operacional rápido.
 */
function ContactRow({
  contact,
}: {
  contact: import('@/lib/customer-contact/types').CustomerContact;
}) {
  const displayName = contact.nome ?? formatPhone(contact.phone);
  const cargoLabel = contact.cargo ? CARGO_LABEL[contact.cargo] : null;
  const cleanPhone = contact.phone.replace(/\D/g, '');
  // Aniversário esse mês? Destaque sutil pra lembrar de mandar mensagem.
  const isBirthdayMonth = (() => {
    if (!contact.birthday) return false;
    try {
      const d = parseISO(contact.birthday);
      return d.getMonth() === new Date().getMonth();
    } catch {
      return false;
    }
  })();
  return (
    <li className="pt-2 first:pt-0 space-y-1">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm truncate">{displayName}</span>
            {cargoLabel && (
              <Badge variant="outline" className="text-[9px] px-1 py-0">
                {cargoLabel}
              </Badge>
            )}
            {contact.is_primary && (
              <Tooltip>
                <TooltipTrigger>
                  <Star className="w-3 h-3 text-status-warning-bold fill-status-warning-bold" />
                </TooltipTrigger>
                <TooltipContent>Contato principal</TooltipContent>
              </Tooltip>
            )}
            {contact.is_decision_maker && (
              <Tooltip>
                <TooltipTrigger>
                  <Award className="w-3 h-3 text-status-info-bold" />
                </TooltipTrigger>
                <TooltipContent>Decision maker (quem decide a compra)</TooltipContent>
              </Tooltip>
            )}
            {isBirthdayMonth && (
              <Tooltip>
                <TooltipTrigger>
                  <Cake className="w-3 h-3 text-status-success-bold" />
                </TooltipTrigger>
                <TooltipContent>
                  Aniversário em {format(parseISO(contact.birthday!), "dd 'de' MMM", { locale: ptBR })}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            {contact.whatsapp_only ? (
              <a
                href={`https://wa.me/${cleanPhone}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline hover:text-foreground transition-colors"
              >
                {formatPhone(contact.phone)} · só WhatsApp
              </a>
            ) : (
              <span className="inline-flex items-center gap-1">
                {formatPhone(contact.phone)}
                <CallButton phone={contact.phone} customerName={contact.nome ?? customer.name} variant="icon" />
              </span>
            )}
          </div>
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              className="text-xs text-muted-foreground hover:underline hover:text-foreground transition-colors truncate block mt-0.5"
            >
              {contact.email}
            </a>
          )}
        </div>
        {!contact.whatsapp_only && (
          <a
            href={`https://wa.me/${cleanPhone}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-status-success-bold transition-colors shrink-0 mt-0.5"
            aria-label="Enviar WhatsApp"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * Linha de score (label esquerda, valor à direita em mono). Usada no card "Score
 * comercial" pra densidade tabular — diferente de DataRow que é vertical (form-like).
 */
function ScoreRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground truncate">{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground/70 mt-0.5">{hint}</div>}
      </div>
      <div className="font-mono text-sm font-medium text-foreground tabular-nums shrink-0">
        {value}
      </div>
    </div>
  );
}

/* ───────────────────  format helpers  ─────────────────── */

function formatDocument(doc: string): string {
  const d = doc.replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}

function formatPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return p;
}

function formatCep(z: string): string {
  const d = z.replace(/\D/g, '');
  if (d.length === 8) return d.replace(/(\d{5})(\d{3})/, '$1-$2');
  return z;
}
