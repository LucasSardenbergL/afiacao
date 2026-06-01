// Visão 360° do cliente (header, KPIs, contato, scores, sumário 360, tabs).
// Extraído verbatim de src/pages/AdminCustomers.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Loader2, Plus, Wrench, Trash2, User, Phone, FileText,
  ChevronLeft, Mail, ShoppingCart, TrendingUp,
  AlertTriangle, MoreHorizontal,
  MessageSquare, Calendar, DollarSign, Package, Activity, Sparkles,
  Factory, Contact,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { decodeHtmlEntities } from '@/lib/format';
import { formatBrPhone, whatsappLink } from '@/lib/phone';
import { CallButton } from '@/components/call/CallButton';
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { CustomerProfile360Summary } from '@/components/customer/CustomerProfile360Summary';
import { CustomerCallsTab } from '@/components/customer/CustomerCallsTab';
import { CustomerProcessTab } from '@/components/customer/CustomerProcessTab';
import { CustomerContactsTab } from '@/components/customer/CustomerContactsTab';
import { fmt, HEALTH_CLASSES, formatDocument } from './config';
import { MetricCard, ScoreItem } from './cards';
import { RequiresPoToggle } from './RequiresPoToggle';
import { AgendarVisitaDialog } from '@/components/visitas/AgendarVisitaDialog';
import type { Customer, ClientScore, ToolCategory, UserTool, SalesOrder } from './types';

export function Customer360View({
  customer,
  score,
  tools,
  orders,
  categories: _categories,
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
  const waHref = customer.phone ? whatsappLink(customer.phone) : null;

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
              <AgendarVisitaDialog
                customerUserId={customer.user_id}
                customerName={customer.name}
                trigger={
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                    <Calendar className="w-3.5 h-3.5 mr-2" /> Agendar visita
                  </DropdownMenuItem>
                }
              />
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
                <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1">{formatBrPhone(customer.phone)}</span>
                <CallButton phone={customer.phone} customerName={customer.name} variant="icon" />
                {waHref && (
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-status-success-bold transition-colors"
                    aria-label="Enviar WhatsApp"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </a>
                )}
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
