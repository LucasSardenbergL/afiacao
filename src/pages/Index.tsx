import { useMemo } from 'react';
import {
  PlusCircle, ClipboardList, ChevronRight, User, ArrowRight,
  Package, Users, Clock, CheckCircle, Building2,
  TrendingUp, BarChart3, FileText
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

import { CustomerDashboard } from '@/components/CustomerDashboard';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';

import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { useBasicProfile } from '@/queries/useProfile';
import { useCustomerPendingOrders, useStaffPendingOrders, useCustomerCount } from '@/queries/useOrders';
import { useUserToolsSummary } from '@/queries/useUserTools';

/* ─── Status labels ─── */
const STATUS_LABELS: Record<string, { label: string; statusClass: string }> = {
  pedido_recebido: { label: 'Recebido', statusClass: 'status-progress' },
  aguardando_coleta: { label: 'Aguardando Coleta', statusClass: 'status-pending' },
  em_triagem: { label: 'Em Triagem', statusClass: 'status-purple' },
  orcamento_enviado: { label: 'Orçamento Enviado', statusClass: 'status-pending' },
  aprovado: { label: 'Aprovado', statusClass: 'status-success' },
  em_afiacao: { label: 'Em Afiação', statusClass: 'status-progress' },
  controle_qualidade: { label: 'Qualidade', statusClass: 'status-indigo' },
  pronto_entrega: { label: 'Pronto p/ Entrega', statusClass: 'status-success' },
  em_rota: { label: 'Em Rota', statusClass: 'status-indigo' },
  entregue: { label: 'Entregue', statusClass: 'bg-muted text-muted-foreground' },
};

/* ─── Main Component ─── */
const Index = () => {
  const navigate = useNavigate();
  const { user, isMaster } = useAuth();
  const { isStaff, isAdmin, loading: roleLoading } = useUserRole();

  // Data hooks
  const { data: profile, isLoading: profileLoading } = useBasicProfile(user?.id);
  const { data: pendingOrders = [], isLoading: customerOrdersLoading } = useCustomerPendingOrders(!isStaff ? user?.id : undefined);
  const { data: allPendingOrders = [], isLoading: staffOrdersLoading } = useStaffPendingOrders(isStaff && !roleLoading);
  const { data: customerCount = 0 } = useCustomerCount(isStaff && !roleLoading);
  const { data: userTools = [] } = useUserToolsSummary(!isStaff ? user?.id : undefined, !isStaff && !roleLoading);

  const loading = roleLoading || profileLoading || (isStaff ? staffOrdersLoading : customerOrdersLoading);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Bom dia';
    if (hour < 18) return 'Boa tarde';
    return 'Boa noite';
  };

  const isCNPJ = profile?.document && profile.document.replace(/\D/g, '').length === 14;
  const displayName = isCNPJ ? profile?.name || 'Usuário' : profile?.name?.split(' ')[0] || 'Usuário';

  if (loading || roleLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  /* ─── CUSTOMER HOME ─── */
  if (!isStaff) {
    return (
      <CustomerDashboard
        profile={profile}
        pendingOrders={pendingOrders}
        userTools={userTools}
        getGreeting={getGreeting}
      />
    );
  }

  /* ─── STAFF / ADMIN HOME ─── */
  return (
    <StaffHome
      displayName={displayName}
      greeting={getGreeting()}
      isAdmin={isAdmin}
      isMaster={isMaster}
      allPendingOrders={allPendingOrders}
      customerCount={customerCount}
      navigate={navigate}
    />
  );
};

export default Index;

/* ══════════════════════════════════════════════════
   Staff Home — extracted for clarity
   ══════════════════════════════════════════════════ */

interface StaffOrder {
  id: string;
  status: string;
  created_at: string;
  service_type: string;
  user_id?: string;
  profiles?: { name: string };
}

interface StaffHomeProps {
  displayName: string;
  greeting: string;
  isAdmin: boolean;
  isMaster: boolean;
  allPendingOrders: StaffOrder[];
  customerCount: number;
  navigate: ReturnType<typeof useNavigate>;
}

function StaffHome({ displayName, greeting, isAdmin, isMaster, allPendingOrders, customerCount, navigate }: StaffHomeProps) {
  /* ─── Derived operational counts ─── */
  const ops = useMemo(() => {
    const byStatus = (s: string) => allPendingOrders.filter(o => o.status === s).length;
    return {
      aguardandoTriagem: byStatus('pedido_recebido') + byStatus('em_triagem'),
      aguardandoColeta: byStatus('aguardando_coleta'),
      aguardandoAprovacao: byStatus('orcamento_enviado'),
      emAndamento: byStatus('em_afiacao') + byStatus('controle_qualidade') + byStatus('aprovado'),
      prontosEntrega: byStatus('pronto_entrega') + byStatus('em_rota'),
      total: allPendingOrders.length,
    };
  }, [allPendingOrders]);

  const quickActions = [
    { icon: PlusCircle, label: 'Novo Pedido', path: '/sales/new' },
    { icon: Users, label: 'Clientes', path: '/admin/customers' },
    { icon: Clock, label: 'Previsão', path: '/admin/demand-forecast' },
    { icon: BarChart3, label: 'Relatórios', path: '/admin/reports' },
  ];

  return (
    <div className="space-y-6">
      {/* ─── Hero Header ─── */}
      <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-10 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-40 h-40 bg-primary/5 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2" />

        <div className="max-w-lg mx-auto relative z-10">
          <div className="flex items-start justify-between mb-6">
            <div className="space-y-1">
              <p className="text-sm text-secondary-foreground/70 font-medium">{greeting},</p>
              <h1 className="text-2xl font-display font-bold tracking-tight">{displayName}</h1>
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium bg-primary/20 text-primary-foreground">
                <Building2 className="w-3 h-3" />
                {isMaster ? 'Master' : isAdmin ? 'Administrador' : 'Funcionário'}
              </span>
            </div>
            <button
              onClick={() => navigate('/profile')}
              className="w-12 h-12 rounded-full bg-primary/90 hover:bg-primary flex items-center justify-center transition-all hover:scale-105 shadow-glow"
            >
              <User className="w-6 h-6 text-primary-foreground" />
            </button>
          </div>

          {/* Executive Summary — admin/master only */}
          {(isAdmin || isMaster) && (
            <div className="grid grid-cols-3 gap-2 mb-4">
              <StatPill icon={Users} value={customerCount} label="Clientes" onClick={() => navigate('/admin/customers')} />
              <StatPill icon={Package} value={ops.total} label="Pedidos ativos" onClick={() => navigate('/admin')} />
              <StatPill icon={TrendingUp} value={ops.prontosEntrega} label="Prontos entrega" onClick={() => navigate('/admin')} />
            </div>
          )}
        </div>
      </header>

      <main className="px-4 -mt-5 max-w-lg mx-auto relative z-20 space-y-5">

        {/* ═══ BLOCO 1: Pendências Operacionais ═══ */}
        <section>
          <h2 className="font-display font-bold text-lg text-foreground mb-3">Pendências</h2>
          <div className="grid grid-cols-3 gap-2">
            <BacklogCard
              count={ops.aguardandoTriagem}
              label="Triagem"
              variant={ops.aguardandoTriagem > 0 ? 'warning' : 'neutral'}
              onClick={() => navigate('/admin')}
            />
            <BacklogCard
              count={ops.aguardandoColeta}
              label="Coleta"
              variant={ops.aguardandoColeta > 0 ? 'info' : 'neutral'}
              onClick={() => navigate('/admin')}
            />
            <BacklogCard
              count={ops.aguardandoAprovacao}
              label="Aprovação"
              variant={ops.aguardandoAprovacao > 0 ? 'destructive' : 'neutral'}
              onClick={() => navigate('/admin')}
            />
          </div>
          {ops.total > 0 && (
            <Button variant="outline" size="sm" className="w-full mt-2 rounded-xl" onClick={() => navigate('/admin')}>
              Ver fila completa
              <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          )}
        </section>

        {/* ═══ BLOCO 2: Resumo do Dia ═══ */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display font-bold text-lg text-foreground">Resumo do Dia</h2>
            <button onClick={() => navigate('/admin')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
              Ver todos <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {allPendingOrders.length > 0 ? (
            <div className="space-y-2">
              {allPendingOrders.slice(0, 5).map((order, i) => {
                const config = STATUS_LABELS[order.status] || { label: order.status, statusClass: 'status-progress' };
                const needsAction = order.status === 'orcamento_enviado';
                return (
                  <Card
                    key={order.id}
                    className={cn(
                      'overflow-hidden hover:shadow-medium transition-shadow cursor-pointer group animate-fade-in',
                      needsAction && 'ring-1 ring-status-warning/40'
                    )}
                    style={{ animationDelay: `${i * 0.04}s` }}
                    onClick={() => navigate(`/admin/orders/${order.id}`)}
                  >
                    <CardContent className="p-3.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0',
                            needsAction ? 'bg-status-warning-bg' : 'bg-muted'
                          )}>
                            <Package className={cn('w-4 h-4', needsAction ? 'text-status-warning' : 'text-muted-foreground')} />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-sm text-foreground truncate">
                              {order.profiles?.name || 'Cliente'}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {format(new Date(order.created_at), "dd/MM 'às' HH:mm", { locale: ptBR })}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {needsAction && (
                            <Badge variant="outline" className="text-[9px] border-status-warning text-status-warning bg-status-warning-bg font-semibold px-1.5 py-0">
                              Ação
                            </Badge>
                          )}
                          <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-semibold border', config.statusClass)}>
                            {config.label}
                          </span>
                          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card className="text-center py-6">
              <CardContent className="space-y-1">
                <CheckCircle className="w-10 h-10 text-primary/60 mx-auto" />
                <p className="font-semibold text-sm text-foreground">Tudo em dia!</p>
                <p className="text-xs text-muted-foreground">Nenhum pedido pendente</p>
              </CardContent>
            </Card>
          )}
        </section>

        {/* ═══ BLOCO 3: Ações Rápidas ═══ */}
        <section>
          <h2 className="font-display font-bold text-lg text-foreground mb-3">Ações Rápidas</h2>
          <div className="grid grid-cols-4 gap-2">
            {quickActions.map(item => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className="bg-card rounded-2xl p-3 shadow-soft border border-border/80 hover:shadow-medium hover:border-primary/20 transition-all flex flex-col items-center gap-2 group"
              >
                <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <item.icon className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <span className="text-[11px] font-semibold text-foreground text-center leading-tight">{item.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* CTA principal */}
        <Card className="shadow-medium border-0 overflow-hidden">
          <CardContent className="p-0">
            <button
              onClick={() => navigate('/admin')}
              className="w-full p-4 flex items-center gap-4 group hover:bg-muted/30 transition-colors"
            >
              <div className="w-12 h-12 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-glow flex-shrink-0 group-hover:scale-105 transition-transform">
                <ClipboardList className="w-6 h-6 text-primary-foreground" />
              </div>
              <div className="flex-1 text-left">
                <h3 className="font-display font-bold text-base text-foreground">Gerenciar Pedidos</h3>
                <p className="text-xs text-muted-foreground">Visualize e atualize os pedidos</p>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:translate-x-1 group-hover:text-primary transition-all" />
            </button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

/* ─── Sub-components ─── */

function StatPill({ icon: Icon, value, label, onClick }: {
  icon: typeof Package; value: number; label: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-secondary-foreground/8 hover:bg-secondary-foreground/14 rounded-2xl p-3 backdrop-blur-sm border border-secondary-foreground/5 transition-colors text-left"
    >
      <Icon className="w-4 h-4 text-secondary-foreground/50 mb-1" />
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      <p className="text-[10px] text-secondary-foreground/50 font-medium">{label}</p>
    </button>
  );
}

function BacklogCard({ count, label, variant, onClick }: {
  count: number; label: string;
  variant: 'warning' | 'info' | 'destructive' | 'neutral';
  onClick: () => void;
}) {
  const styles: Record<typeof variant, string> = {
    warning: 'border-status-warning/30 bg-status-warning-bg/50',
    info: 'border-primary/20 bg-primary/5',
    destructive: 'border-destructive/20 bg-destructive/5',
    neutral: 'border-border bg-card',
  };
  const countColor: Record<typeof variant, string> = {
    warning: 'text-status-warning',
    info: 'text-primary',
    destructive: 'text-destructive',
    neutral: 'text-muted-foreground',
  };

  return (
    <button onClick={onClick} className={cn('rounded-2xl p-3 border text-center transition-all hover:shadow-medium', styles[variant])}>
      <p className={cn('text-2xl font-bold', count > 0 ? countColor[variant] : 'text-muted-foreground')}>{count}</p>
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
    </button>
  );
}
