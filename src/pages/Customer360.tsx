import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parseISO, subMonths } from 'date-fns';
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
} from 'lucide-react';
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
import {
  formatBRL,
  formatPctMaybe,
  splitEmails,
  formatCustomerType,
  orderStatusTone,
  formatDateOrDash,
  formatRelative,
  initials,
  healthTone,
  churnTone,
  formatDocument,
  formatPhone,
  formatCep,
} from '@/components/customer360/format';
import {
  useCustomerCore,
  useCustomerAddress,
  useCustomerMetrics,
  useCustomerScore,
  useCustomerPreferredItems,
  useCustomerOrders,
  useCustomerInteractions,
} from '@/components/customer360/hooks';
import { KpiCard, DataRow, ContactRow, ScoreRow } from '@/components/customer360/components';

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
