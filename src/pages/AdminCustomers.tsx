import { useState, useEffect, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';

const PAGE_SIZE = 100;
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { useNavigate, useParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AddToolDialog } from '@/components/AddToolDialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Loader2, Plus, Wrench, Trash2, Search, User, Phone, FileText,
  ChevronLeft, Mail, Building2, ShoppingCart, TrendingUp, ArrowUpRight,
  BarChart3, Clock, AlertTriangle, ChevronRight, Filter, MoreHorizontal,
  MessageSquare, Calendar, DollarSign, Package, Activity, Users, Sparkles,
} from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useUrlState } from '@/hooks/useUrlState';
import { useCustomerSegments } from '@/hooks/useCustomerSegments';
import { Save, Bookmark, X as XIcon } from 'lucide-react';
import { decodeHtmlEntities } from '@/lib/format';
import { CustomerProfile360Summary } from '@/components/customer/CustomerProfile360Summary';
import { CustomerCallsTab } from '@/components/customer/CustomerCallsTab';
import { CustomerProcessTab } from '@/components/customer/CustomerProcessTab';
import { CustomerContactsTab } from '@/components/customer/CustomerContactsTab';
import { Factory, Contact } from 'lucide-react';

/* ─── Types ─── */
interface Customer {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  customer_type: string | null;
  created_at: string;
  requires_po?: boolean;
}

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}

interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories: ToolCategory;
}

interface ClientScore {
  health_score: number;
  health_class: string;
  churn_risk: number;
  expansion_score: number;
  priority_score: number;
  avg_monthly_spend_180d: number;
  days_since_last_purchase: number;
  category_count: number;
  gross_margin_pct: number;
}

interface SalesOrder {
  id: string;
  total: number;
  status: string;
  created_at: string;
  items: any;
}

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const HEALTH_CLASSES: Record<string, { label: string; className: string }> = {
  saudavel: { label: 'Saudável', className: 'status-success' },
  alerta: { label: 'Alerta', className: 'status-pending' },
  critico: { label: 'Crítico', className: 'status-danger' },
};

/* ─── Customer List View ─── */
function CustomerListView({
  customers,
  scores,
  loading,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  loading: boolean;
  onSelect: (c: Customer) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const sentinelRef = useInfiniteScroll(onLoadMore, hasNextPage && !isFetchingNextPage);
  // Filtros sincronizados com URL (compartilhável, sobrevive a F5)
  const [urlState, setUrlState] = useUrlState({ search: '', health: 'all' });
  const searchQuery = urlState.search;
  const filterHealth = urlState.health;
  const setSearchQuery = (v: string) => setUrlState({ search: v });
  const setFilterHealth = (v: string) => setUrlState({ health: v });

  const { segments, save: saveSegment, remove: removeSegment } = useCustomerSegments();
  const [savingSegment, setSavingSegment] = useState(false);
  const [newSegmentName, setNewSegmentName] = useState('');

  const filtered = useMemo(() => {
    let result = customers;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.document?.includes(q) ||
        c.email?.toLowerCase().includes(q)
      );
    }
    if (filterHealth !== 'all') {
      result = result.filter(c => {
        const score = scores.get(c.user_id);
        return score?.health_class === filterHealth;
      });
    }
    return result;
  }, [customers, searchQuery, filterHealth, scores]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Clientes</h1>
          <p className="text-sm text-muted-foreground">{customers.length} clientes na carteira</p>
        </div>
      </div>

      {/* Segmentos salvos (chips) */}
      {(segments.length > 0 || savingSegment || (searchQuery || filterHealth !== 'all')) && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Bookmark className="w-3 h-3" />
            Segmentos
          </span>
          {segments.map((seg) => (
            <span
              key={seg.id}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-md text-xs bg-muted hover:bg-muted/70 border border-border"
            >
              <button
                type="button"
                onClick={() => setUrlState({ search: seg.filters.search ?? '', health: seg.filters.health ?? 'all' })}
                className="font-medium"
                title="Aplicar segmento"
              >
                {seg.name}
              </button>
              <button
                type="button"
                onClick={() => removeSegment(seg.id)}
                className="text-muted-foreground hover:text-destructive p-0.5"
                aria-label={`Remover segmento ${seg.name}`}
              >
                <XIcon className="w-3 h-3" />
              </button>
            </span>
          ))}
          {(searchQuery || filterHealth !== 'all') && !savingSegment && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={() => setSavingSegment(true)}
            >
              <Save className="w-3 h-3" />
              Salvar como segmento
            </Button>
          )}
          {savingSegment && (
            <span className="inline-flex items-center gap-1.5">
              <Input
                placeholder="Nome do segmento"
                value={newSegmentName}
                autoFocus
                onChange={(e) => setNewSegmentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newSegmentName.trim()) {
                    saveSegment(newSegmentName.trim(), { search: searchQuery, health: filterHealth });
                    setNewSegmentName('');
                    setSavingSegment(false);
                  } else if (e.key === 'Escape') {
                    setNewSegmentName('');
                    setSavingSegment(false);
                  }
                }}
                className="h-7 w-48 text-xs"
              />
              <Button
                size="sm"
                variant="default"
                className="h-7"
                disabled={!newSegmentName.trim()}
                onClick={() => {
                  saveSegment(newSegmentName.trim(), { search: searchQuery, health: filterHealth });
                  setNewSegmentName('');
                  setSavingSegment(false);
                }}
              >
                Salvar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  setNewSegmentName('');
                  setSavingSegment(false);
                }}
              >
                Cancelar
              </Button>
            </span>
          )}
        </div>
      )}

      {/* Search + Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, CPF/CNPJ ou e-mail..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-1.5">
              <Filter className="w-3.5 h-3.5" />
              Saúde
              {filterHealth !== 'all' && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">
                  {HEALTH_CLASSES[filterHealth]?.label}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setFilterHealth('all')}>Todos</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('saudavel')}>🟢 Saudável</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('alerta')}>🟡 Alerta</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('critico')}>🔴 Crítico</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Dense Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Documento</th>
                <th className="text-center px-3 py-2.5 font-medium text-muted-foreground">Saúde</th>
                <th className="text-right px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Gasto mensal</th>
                <th className="text-center px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Dias s/ compra</th>
                <th className="text-right px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Prioridade</th>
                <th className="w-10 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((customer) => {
                const score = scores.get(customer.user_id);
                const healthInfo = HEALTH_CLASSES[score?.health_class || 'critico'];

                return (
                  <tr
                    key={customer.user_id}
                    className="border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => onSelect(customer)}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <User className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate text-foreground">{decodeHtmlEntities(customer.name)}</p>
                          {customer.phone && (
                            <p className="text-xs text-muted-foreground">{customer.phone}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 hidden md:table-cell">
                      <span className="text-xs text-muted-foreground font-mono">
                        {formatDocument(customer.document)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <Badge variant="outline" className={cn('text-[10px]', healthInfo?.className)}>
                        {healthInfo?.label || 'N/A'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right hidden lg:table-cell">
                      <span className="text-xs font-medium tabular-nums">
                        {score ? fmt(score.avg_monthly_spend_180d) : '-'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center hidden lg:table-cell">
                      {score?.days_since_last_purchase != null ? (
                        <span className={cn(
                          'text-xs font-medium tabular-nums',
                          score.days_since_last_purchase > 60 ? 'text-status-error' :
                          score.days_since_last_purchase > 30 ? 'text-status-warning' :
                          'text-muted-foreground'
                        )}>
                          {score.days_since_last_purchase}d
                        </span>
                      ) : '-'}
                    </td>
                    <td className="px-3 py-2.5 text-right hidden md:table-cell">
                      {score ? (
                        <span className="text-xs font-semibold tabular-nums">{score.priority_score.toFixed(1)}</span>
                      ) : '-'}
                    </td>
                    <td className="px-2 py-2.5">
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <EmptyState
            icon={searchQuery || filterHealth !== 'all' ? Search : Users}
            title={searchQuery || filterHealth !== 'all' ? 'Nenhum cliente com esses filtros' : 'Nenhum cliente na carteira'}
            description={
              searchQuery || filterHealth !== 'all'
                ? 'Tente buscar por nome, CNPJ ou e-mail; ou trocar o filtro de saúde.'
                : 'Quando um cliente for cadastrado ele vai aparecer aqui automaticamente.'
            }
            actionLabel={searchQuery || filterHealth !== 'all' ? 'Limpar filtros' : undefined}
            onAction={searchQuery || filterHealth !== 'all' ? () => setUrlState({ search: '', health: 'all' }) : undefined}
          />
        )}

        {/* Infinite scroll sentinel + fallback botão */}
        {hasNextPage && (
          <div ref={sentinelRef} className="py-4 flex justify-center border-t">
            {isFetchingNextPage ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : (
              <Button variant="outline" size="sm" onClick={onLoadMore}>
                Carregar mais
              </Button>
            )}
          </div>
        )}
        {!hasNextPage && customers.length > 0 && (
          <p className="text-center text-xs text-muted-foreground py-4 border-t">
            Todos os clientes carregados ({customers.length})
          </p>
        )}
      </Card>
    </div>
  );
}

/* ─── Customer 360 Profile View ─── */
function RequiresPoToggle({ customer }: { customer: Customer }) {
  const [checked, setChecked] = useState<boolean>(!!customer.requires_po);
  const [saving, setSaving] = useState(false);

  const handleChange = async (next: boolean) => {
    setSaving(true);
    const prev = checked;
    setChecked(next);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ requires_po: next })
        .eq('user_id', customer.user_id);
      if (error) throw error;
      customer.requires_po = next;
      toast.success(next ? 'Cliente exige ordem de compra' : 'Ordem de compra desativada');
    } catch (e: any) {
      setChecked(prev);
      toast.error('Erro ao salvar', { description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="flex items-center gap-2 text-sm pt-2 border-t border-border cursor-pointer">
      <Checkbox checked={checked} disabled={saving} onCheckedChange={(v) => handleChange(!!v)} />
      <span>Exige ordem de compra</span>
    </label>
  );
}

function Customer360View({
  customer,
  score,
  tools,
  orders,
  categories,
  loadingTools,
  loadingOrders,
  onBack,
  onAddTool,
  onDeleteTool,
}: {
  customer: Customer;
  score: ClientScore | undefined;
  tools: UserTool[];
  orders: SalesOrder[];
  categories: ToolCategory[];
  loadingTools: boolean;
  loadingOrders: boolean;
  onBack: () => void;
  onAddTool: () => void;
  onDeleteTool: (id: string) => void;
}) {
  const navigate = useNavigate();
  const healthInfo = HEALTH_CLASSES[score?.health_class || 'critico'];

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ChevronLeft className="w-4 h-4" />
        Clientes
      </button>

      {/* Profile Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <User className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">{decodeHtmlEntities(customer.name)}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              {customer.document && (
                <span className="text-xs text-muted-foreground font-mono">{formatDocument(customer.document)}</span>
              )}
              {score && (
                <Badge variant="outline" className={cn('text-[10px]', healthInfo?.className)}>
                  {healthInfo?.label}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="default" className="gap-1.5 h-8"
            onClick={() => navigate(`/admin/customers/${customer.user_id}/360`)}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Ver 360°
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 h-8"
            onClick={() => navigate(`/sales/new`)}
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            Novo pedido
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem><Phone className="w-3.5 h-3.5 mr-2" /> Ligar</DropdownMenuItem>
              <DropdownMenuItem><MessageSquare className="w-3.5 h-3.5 mr-2" /> WhatsApp</DropdownMenuItem>
              <DropdownMenuItem><Calendar className="w-3.5 h-3.5 mr-2" /> Agendar visita</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* KPI Cards */}
      {score && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard icon={DollarSign} label="Gasto mensal" value={fmt(score.avg_monthly_spend_180d)} />
          <MetricCard icon={Activity} label="Score saúde" value={score.health_score.toFixed(0)} />
          <MetricCard
            icon={AlertTriangle}
            label="Risco churn"
            value={`${(score.churn_risk * 100).toFixed(0)}%`}
            danger={score.churn_risk > 0.5}
          />
          <MetricCard icon={Package} label="Categorias" value={String(score.category_count)} />
        </div>
      )}

      {/* Contact Info + Details */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Contact */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Contato</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {customer.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="truncate">{customer.email}</span>
              </div>
            )}
            {customer.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                <span>{customer.phone}</span>
              </div>
            )}
            {customer.document && (
              <div className="flex items-center gap-2 text-sm">
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="font-mono text-xs">{formatDocument(customer.document)}</span>
              </div>
            )}
            <RequiresPoToggle customer={customer} />
          </CardContent>
        </Card>

        {/* Scoring Details (Manager only visual) */}
        {score && (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Scores detalhados</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
                <ScoreItem label="Margem" value={`${(score.gross_margin_pct * 100).toFixed(1)}%`} />
                <ScoreItem label="Expansão" value={score.expansion_score.toFixed(1)} />
                <ScoreItem label="Prioridade" value={score.priority_score.toFixed(1)} />
                <ScoreItem label="Dias s/ compra" value={String(score.days_since_last_purchase)} danger={score.days_since_last_purchase > 60} />
                <ScoreItem label="Intervalo médio" value={`${score.avg_monthly_spend_180d > 0 ? Math.round(Number(score.avg_monthly_spend_180d)) : '-'}d`} />
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Perfil 360 v1 — sumário das chamadas (só aparece se cliente já tem call history) */}
      <CustomerProfile360Summary customerId={customer.user_id} />

      {/* Tabs: Pedidos / Ferramentas / Oportunidades / Chamadas */}
      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders" className="gap-1.5">
            <ShoppingCart className="w-3.5 h-3.5" /> Pedidos
          </TabsTrigger>
          <TabsTrigger value="tools" className="gap-1.5">
            <Wrench className="w-3.5 h-3.5" /> Ferramentas
            <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{tools.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="recommendations" className="gap-1.5">
            <TrendingUp className="w-3.5 h-3.5" /> Oportunidades
          </TabsTrigger>
          <TabsTrigger value="calls" className="gap-1.5">
            <Phone className="w-3.5 h-3.5" /> Chamadas
          </TabsTrigger>
          <TabsTrigger value="process" className="gap-1.5">
            <Factory className="w-3.5 h-3.5" /> Processo
          </TabsTrigger>
          <TabsTrigger value="contacts" className="gap-1.5">
            <Contact className="w-3.5 h-3.5" /> Contatos
          </TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-3">
          {loadingOrders ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : orders.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <ShoppingCart className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">Nenhum pedido registrado</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Data</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Itens</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => {
                      const items = Array.isArray(order.items) ? order.items : [];
                      return (
                        <tr key={order.id} className="border-b last:border-b-0 hover:bg-muted/20">
                          <td className="px-4 py-2 text-xs">
                            {format(new Date(order.created_at), 'dd/MM/yy', { locale: ptBR })}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {items.length} {items.length === 1 ? 'item' : 'itens'}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Badge variant="outline" className="text-[10px]">{order.status}</Badge>
                          </td>
                          <td className="px-4 py-2 text-right text-xs font-medium">{fmt(order.total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="tools" className="mt-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">{tools.length} ferramentas cadastradas</span>
            <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={onAddTool}>
              <Plus className="w-3.5 h-3.5" /> Adicionar
            </Button>
          </div>
          {loadingTools ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : tools.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <Wrench className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">Nenhuma ferramenta cadastrada</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onAddTool}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Adicionar ferramenta
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {tools.map((tool) => (
                <Card key={tool.id}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Wrench className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {tool.generated_name || tool.custom_name || tool.tool_categories?.name}
                      </p>
                      <p className="text-xs text-muted-foreground">{tool.tool_categories?.name}</p>
                    </div>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => onDeleteTool(tool.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="recommendations" className="mt-3">
          <RecommendationsPanel
            customerId={customer.user_id}
            title="O que está faltando no mix"
          />
        </TabsContent>

        <TabsContent value="calls" className="mt-3">
          <CustomerCallsTab customerId={customer.user_id} />
        </TabsContent>

        <TabsContent value="process" className="mt-3">
          <CustomerProcessTab customerId={customer.user_id} />
        </TabsContent>

        <TabsContent value="contacts" className="mt-3">
          <CustomerContactsTab customerId={customer.user_id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ─── Helper Components ─── */
function MetricCard({ icon: Icon, label, value, danger }: { icon: any; label: string; value: string; danger?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Icon className={cn('w-3.5 h-3.5', danger ? 'text-destructive' : 'text-muted-foreground')} />
          <span className="text-[11px] text-muted-foreground">{label}</span>
        </div>
        <p className={cn('text-lg font-semibold', danger && 'text-destructive')}>{value}</p>
      </CardContent>
    </Card>
  );
}

function ScoreItem({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="text-center">
      <p className="text-[10px] text-muted-foreground mb-0.5">{label}</p>
      <p className={cn('text-sm font-semibold', danger && 'text-destructive')}>{value}</p>
    </div>
  );
}

function formatDocument(doc: string | null) {
  if (!doc) return '-';
  if (doc.length === 11) return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (doc.length === 14) return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}

/* ─── Main Page ─── */
const AdminCustomers = () => {
  const navigate = useNavigate();
  const { customerId } = useParams<{ customerId?: string }>();
  const { user, isStaff, loading: authLoading } = useAuth();

  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerTools, setCustomerTools] = useState<UserTool[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [scores, setScores] = useState<Map<string, ClientScore>>(new Map());
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  /* ─── Customers: infinite query (100 por página) ─── */
  // Buscamos employee_ids 1× pra filtrar client-side (defensivo — eq('is_employee', false)
  // já filtra no DB, mas mantemos a verificação contra user_roles caso o flag esteja stale)
  const employeeIdsQuery = useInfiniteQuery({
    queryKey: ['admin-customers-employee-ids'],
    enabled: isStaff,
    staleTime: 5 * 60_000,
    initialPageParam: 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('user_id')
        .in('role', ['master', 'employee']);
      return new Set((data || []).map((r: any) => r.user_id));
    },
    getNextPageParam: () => undefined,
  });
  const employeeIds = employeeIdsQuery.data?.pages[0] || new Set<string>();

  const customersQuery = useInfiniteQuery({
    queryKey: ['admin-customers-paginated'],
    enabled: isStaff,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const start = (pageParam as number) * PAGE_SIZE;
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, email, phone, document, customer_type, created_at, requires_po')
        .eq('is_employee', false)
        .order('name')
        .range(start, start + PAGE_SIZE - 1);
      if (error) throw error;
      return (data || []) as Customer[];
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length : undefined,
  });

  // Customers visíveis (filter defensivo de employees depois do fetch — pode reduzir
  // tamanho da page mas não afeta getNextPageParam que olha o raw 100)
  const customers = useMemo<Customer[]>(() => {
    const raw = customersQuery.data?.pages.flat() || [];
    return raw.filter((p) => !employeeIds.has(p.user_id));
  }, [customersQuery.data, employeeIds]);

  const loading = customersQuery.isLoading;

  useEffect(() => {
    if (user && isStaff) {
      loadCategories();
      loadScores();
    }
  }, [user, isStaff]);

  useEffect(() => {
    if (customerId && customers.length > 0) {
      const customer = customers.find(c => c.user_id === customerId);
      if (customer) {
        setSelectedCustomer(customer);
        loadCustomerTools(customerId);
        loadCustomerOrders(customerId);
      }
    }
  }, [customerId, customers]);

  const loadCategories = async () => {
    const { data } = await supabase.from('tool_categories').select('*').order('name');
    if (data) setCategories(data);
  };

  const loadScores = async () => {
    if (!user?.id) return;
    try {
      const { data } = await supabase
        .from('farmer_client_scores')
        .select('customer_user_id, health_score, health_class, churn_risk, expansion_score, priority_score, avg_monthly_spend_180d, days_since_last_purchase, category_count, gross_margin_pct, avg_repurchase_interval')
        .eq('farmer_id', user.id);
      if (data) {
        const map = new Map<string, ClientScore>();
        data.forEach((s: any) => map.set(s.customer_user_id, s));
        setScores(map);
      }
    } catch (e) {
      console.error('Error loading scores:', e);
    }
  };

  const loadCustomerTools = async (userId: string) => {
    setLoadingTools(true);
    try {
      const { data } = await supabase
        .from('user_tools')
        .select('*, tool_categories (*)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      setCustomerTools((data || []) as unknown as UserTool[]);
    } catch (error) {
      console.error('Error loading customer tools:', error);
    } finally {
      setLoadingTools(false);
    }
  };

  const loadCustomerOrders = async (userId: string) => {
    setLoadingOrders(true);
    try {
      const { data } = await supabase
        .from('sales_orders')
        .select('id, total, status, created_at, items')
        .eq('customer_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      setOrders((data || []) as SalesOrder[]);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoadingOrders(false);
    }
  };

  const handleSelectCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    loadCustomerTools(customer.user_id);
    loadCustomerOrders(customer.user_id);
    navigate(`/admin/customers/${customer.user_id}`);
  };

  const handleDeleteTool = async (toolId: string) => {
    try {
      const { error } = await supabase.from('user_tools').delete().eq('id', toolId);
      if (error) throw error;
      toast.success('Ferramenta removida');
      setCustomerTools(prev => prev.filter(t => t.id !== toolId));
    } catch (error) {
      toast.error('Erro ao remover');
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isStaff) return null;

  return (
    <>
      <AddToolDialog
        open={addToolDialogOpen}
        onOpenChange={setAddToolDialogOpen}
        onToolAdded={() => selectedCustomer && loadCustomerTools(selectedCustomer.user_id)}
        categories={categories}
        targetUserId={selectedCustomer?.user_id}
      />

      {selectedCustomer ? (
        <Customer360View
          customer={selectedCustomer}
          score={scores.get(selectedCustomer.user_id)}
          tools={customerTools}
          orders={orders}
          categories={categories}
          loadingTools={loadingTools}
          loadingOrders={loadingOrders}
          onBack={() => {
            setSelectedCustomer(null);
            navigate('/admin/customers');
          }}
          onAddTool={() => setAddToolDialogOpen(true)}
          onDeleteTool={handleDeleteTool}
        />
      ) : (
        <CustomerListView
          customers={customers}
          scores={scores}
          loading={loading}
          onSelect={handleSelectCustomer}
          hasNextPage={!!customersQuery.hasNextPage}
          isFetchingNextPage={customersQuery.isFetchingNextPage}
          onLoadMore={() => customersQuery.fetchNextPage()}
        />
      )}
    </>
  );
};

export default AdminCustomers;
