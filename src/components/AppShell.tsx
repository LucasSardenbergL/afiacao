import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, Lock, Calculator, FileText, Palette, Beaker, FileUp, Droplets, LayoutDashboard, Users, ShoppingCart, ShoppingBag, Phone, GraduationCap, BarChart3, Settings, ChevronLeft, ChevronRight, Search, Bell, User, LogOut, Package, TrendingUp, Headphones, Target, Menu, X, ClipboardList, PlusCircle, Shield, Wrench, Award, Scissors, DollarSign, Layers, Printer, UserCheck, FileCheck, Boxes, AlertTriangle, PlayCircle, Factory, Truck, Percent, Sparkles, Handshake } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { AppShellProvider } from '@/contexts/AppShellContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { HelpDrawer } from '@/components/help/HelpDrawer';

/* ─── Navigation config ─── */
interface NavItem {
  icon: React.ElementType;
  label: string;
  path: string;
  badge?: number;
  managerOnly?: boolean;
}

const unifiedNavSections: { title: string; items: NavItem[] }[] = [
  {
    title: 'Principal',
    items: [
      { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
      { icon: Users, label: 'Clientes', path: '/admin/customers' },
    ],
  },
  {
    title: 'Afiação',
    items: [
      { icon: Wrench, label: 'Ferramentas', path: '/tools' },
      { icon: Award, label: 'Gamificação', path: '/gamification' },
    ],
  },
  {
    title: 'Vendas',
    items: [
      { icon: ShoppingCart, label: 'Pedidos', path: '/sales' },
      { icon: PlusCircle, label: 'Novo Pedido', path: '/sales/new' },
      { icon: FileText, label: 'Orçamentos', path: '/sales/quotes' },
      { icon: Printer, label: 'Impressão', path: '/sales/print' },
      { icon: TrendingUp, label: 'Recomendações', path: '/farmer/recommendations' },
      { icon: Target, label: 'Bundles', path: '/farmer/bundles' },
    ],
  },
  {
    title: 'Estoque',
    items: [
      { icon: FileCheck, label: 'Recebimento', path: '/recebimento' },
      { icon: Package, label: 'Picking', path: '/picking' },
    ],
  },
  {
    title: 'Reposição',
    items: [
      { icon: Boxes, label: 'Revisão de parâmetros', path: '/admin/reposicao/revisao', managerOnly: true },
      { icon: ClipboardList, label: 'Histórico de alterações', path: '/admin/reposicao/historico', managerOnly: true },
      { icon: AlertTriangle, label: 'Alertas de outlier', path: '/admin/reposicao/alertas', managerOnly: true },
      { icon: Factory, label: 'Grupos de produção', path: '/admin/reposicao/grupos-producao', managerOnly: true },
      { icon: Truck, label: 'Cadeia logística', path: '/admin/reposicao/cadeia-logistica', managerOnly: true },
      { icon: ShoppingBag, label: 'Pedidos sugeridos', path: '/admin/reposicao/pedidos', managerOnly: true },
      { icon: Target, label: 'SLA de fornecedor', path: '/admin/reposicao/sla-fornecedor', managerOnly: true },
      { icon: PlayCircle, label: 'Aplicação no Omie', path: '/admin/reposicao/aplicacao', managerOnly: true },
      { icon: Sparkles, label: 'Oportunidades', path: '/admin/reposicao/oportunidades', managerOnly: true },
      { icon: Handshake, label: 'Negociação Paralela', path: '/admin/reposicao/negociacao-paralela', managerOnly: true },
      { icon: Percent, label: 'Promoções', path: '/admin/reposicao/promocoes', managerOnly: true },
      { icon: TrendingUp, label: 'Aumentos anunciados', path: '/admin/reposicao/aumentos', managerOnly: true },
    ],
  },
  {
    title: 'Produção',
    items: [
      { icon: Wrench, label: 'Ordens de Produção', path: '/producao' },
    ],
  },
  {
    title: 'Performance',
    items: [
      { icon: Target, label: 'Avaliação Trimestral', path: '/admin/des/trimestre-atual', managerOnly: true },
      { icon: Phone, label: 'Ligações', path: '/farmer/calls' },
      { icon: Headphones, label: 'Copilot', path: '/farmer/copilot' },
      { icon: GraduationCap, label: 'Coaching SPIN', path: '/coaching' },
    ],
  },
  {
    title: 'Inteligência',
    items: [
      { icon: BarChart3, label: 'Dashboard Intel', path: '/intelligence' },
      { icon: Target, label: 'AI Ops', path: '/ai-ops' },
    ],
  },
  {
    title: 'Financeiro',
    items: [
      { icon: Shield, label: 'Cockpit CFO', path: '/financeiro/cockpit', managerOnly: true },
      { icon: DollarSign, label: 'Painel Financeiro', path: '/financeiro', managerOnly: true },
      { icon: TrendingUp, label: 'Capital de Giro', path: '/financeiro/capital-giro', managerOnly: true },
      { icon: ClipboardList, label: 'Fechamento Mensal', path: '/financeiro/fechamento', managerOnly: true },
      { icon: BarChart3, label: 'Exploração Analítica', path: '/financeiro/analytics', managerOnly: true },
      { icon: Scissors, label: 'Conciliação', path: '/financeiro/conciliacao', managerOnly: true },
      { icon: Target, label: 'Orçado vs Real', path: '/financeiro/orcamento', managerOnly: true },
      { icon: Layers, label: 'Intercompany', path: '/financeiro/intercompany', managerOnly: true },
      { icon: Calculator, label: 'Tributário', path: '/financeiro/tributario', managerOnly: true },
      { icon: Layers, label: 'Mapeamento DRE', path: '/financeiro/mapping', managerOnly: true },
      { icon: Settings, label: 'Sincronização', path: '/financeiro/sync', managerOnly: true },
    ],
  },
  {
    title: 'Tintométrico',
    items: [
      { icon: Palette, label: 'Dashboard', path: '/tintometrico', managerOnly: true },
      { icon: Beaker, label: 'Fórmulas', path: '/tintometrico/formulas', managerOnly: true },
      { icon: FileUp, label: 'Importar', path: '/tintometrico/importar', managerOnly: true },
      { icon: Package, label: 'Mapeamento Omie', path: '/tintometrico/mapeamento', managerOnly: true },
      { icon: Calculator, label: 'Precificação', path: '/tintometrico/precos', managerOnly: true },
      { icon: Droplets, label: 'Corantes', path: '/tintometrico/corantes', managerOnly: true },
      { icon: Settings, label: 'Integrações', path: '/tintometrico/integracoes', managerOnly: true },
      { icon: ClipboardList, label: 'Reconciliação', path: '/tintometrico/reconciliacao', managerOnly: true },
      { icon: BarChart3, label: 'Sync Runs', path: '/tintometrico/sync-runs', managerOnly: true },
      { icon: BookOpen, label: 'API Contract', path: '/tintometrico/api-contract', managerOnly: true },
    ],
  },
  {
    title: 'Automação',
    items: [
      { icon: Bell, label: 'Notificações', path: '/admin/notificacoes', managerOnly: true },
    ],
  },
  {
    title: 'Gestão',
    items: [
      { icon: UserCheck, label: 'Liberar Acessos', path: '/admin/approvals', managerOnly: true },
      { icon: Shield, label: 'Admin', path: '/admin', managerOnly: true },
      { icon: BarChart3, label: 'Relatórios', path: '/admin/monthly-reports', managerOnly: true },
      { icon: TrendingUp, label: 'Analytics & Sync', path: '/admin/analytics-sync', managerOnly: true },
      { icon: Shield, label: 'Governança', path: '/governance/users', managerOnly: true },
      { icon: Lock, label: 'Permissões', path: '/governance/permissions', managerOnly: true },
      { icon: Calculator, label: 'Parâmetros', path: '/governance/math', managerOnly: true },
      { icon: FileText, label: 'Auditoria', path: '/governance/audit', managerOnly: true },
      { icon: Settings, label: 'Configurações', path: '/settings', managerOnly: true },
    ],
  },
];

const docNavSection: { title: string; items: NavItem[] } = {
  title: 'Documentação',
  items: [
    { icon: BookOpen, label: 'Ajuda', path: '/admin/ajuda' },
    { icon: BookOpen, label: 'Design System', path: '/design-system' },
    { icon: BookOpen, label: 'UX Rules', path: '/ux-rules' },
  ],
};

function useSalesOnlyRestriction() {
  const { user } = useAuth();

  const { data: salesOnlyCpfs } = useQuery({
    queryKey: ['config', 'sales_only_cpfs'],
    queryFn: async () => {
      const { data } = await supabase
        .from('company_config')
        .select('value')
        .eq('key', 'sales_only_cpfs')
        .maybeSingle();
      return data?.value ? JSON.parse(data.value) as string[] : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: userDoc } = useQuery({
    queryKey: ['profile', 'document', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('document')
        .eq('user_id', user!.id)
        .maybeSingle();
      return data?.document?.replace(/\D/g, '') || null;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  if (!salesOnlyCpfs || !userDoc) return false;
  return salesOnlyCpfs.includes(userDoc);
}

/* ─── Sidebar ─── */
function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isStaff } = useUserRole();
  const isSalesOnly = useSalesOnlyRestriction();

  // Contador de alertas de outlier pendentes (críticos + atenção)
  const { data: outlierPendentes } = useQuery({
    queryKey: ['outlier-pendentes-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('eventos_outlier')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pendente')
        .in('severidade', ['critico', 'atencao']);
      return count ?? 0;
    },
    enabled: isStaff,
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // Contador de pedidos pendentes/bloqueados do dia atual
  const { data: pedidosPendentes } = useQuery({
    queryKey: ['pedidos-pendentes-count'],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { count } = await supabase
        .from('pedido_compra_sugerido')
        .select('*', { count: 'exact', head: true })
        .eq('data_ciclo', today)
        .in('status', ['pendente_aprovacao', 'bloqueado_guardrail']);
      return count ?? 0;
    },
    enabled: isStaff,
    refetchInterval: 30000,
    staleTime: 15000,
  });

  // Contador de aumentos ativos aguardando vigência
  const { data: aumentosAtivos } = useQuery({
    queryKey: ['aumentos-ativos-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('fornecedor_aumento_anunciado' as any)
        .select('*', { count: 'exact', head: true })
        .eq('estado', 'ativo');
      return count ?? 0;
    },
    refetchInterval: 60000,
  });

  // Contador de oportunidades econômicas ativas hoje (OBEN)
  const { data: oportunidadesAtivas } = useQuery({
    queryKey: ['oportunidades-ativas-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('v_oportunidade_economica_hoje' as any)
        .select('*', { count: 'exact', head: true })
        .eq('empresa', 'OBEN');
      return count ?? 0;
    },
    enabled: isStaff,
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // Contador de sugestões novas de negociação paralela (OBEN)
  const { data: negociacaoNovasCount } = useQuery({
    queryKey: ['negociacao-paralela-sugestoes-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('v_sugestao_negociacao_ativa' as any)
        .select('*', { count: 'exact', head: true })
        .eq('empresa', 'OBEN')
        .eq('status', 'nova');
      return count ?? 0;
    },
    enabled: isStaff,
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // Contador de alertas de notificação pendentes
  const { data: notificacoesPendentes } = useQuery({
    queryKey: ['notificacoes-pendentes-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('fornecedor_alerta')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pendente_notificacao');
      return count ?? 0;
    },
    enabled: isStaff,
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const sectionsWithBadges = React.useMemo(
    () => [...unifiedNavSections, docNavSection].map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (it.path === '/admin/reposicao/alertas' && outlierPendentes) {
          return { ...it, badge: outlierPendentes };
        }
        if (it.path === '/admin/reposicao/pedidos' && pedidosPendentes) {
          return { ...it, badge: pedidosPendentes };
        }
        if (it.path === '/admin/reposicao/aumentos' && aumentosAtivos) {
          return { ...it, badge: aumentosAtivos };
        }
        if (it.path === '/admin/reposicao/oportunidades' && oportunidadesAtivas) {
          return { ...it, badge: oportunidadesAtivas };
        }
        if (it.path === '/admin/reposicao/negociacao-paralela' && negociacaoNovasCount) {
          return { ...it, badge: negociacaoNovasCount };
        }
        if (it.path === '/admin/notificacoes' && notificacoesPendentes) {
          return { ...it, badge: notificacoesPendentes, badgeVariant: 'destructive' as const };
        }
        return it;
      }),
    })),
    [outlierPendentes, pedidosPendentes, aumentosAtivos, oportunidadesAtivas, negociacaoNovasCount, notificacoesPendentes],
  );

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 bottom-0 z-40 flex flex-col overflow-hidden bg-sidebar border-r border-sidebar-border transition-all duration-200',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar'
      )}
    >
      {/* Logo */}
      <div className={cn(
        'flex items-center h-topbar border-b border-sidebar-border px-3',
        collapsed ? 'justify-center' : 'justify-between'
      )}>
        {!collapsed && (
          <div className="flex items-center gap-2">
            <Scissors className="w-5 h-5 text-primary" />
            <span className="text-sidebar-primary-foreground font-semibold text-lg tracking-tight">
              Central
            </span>
          </div>
        )}
        {collapsed && <Scissors className="w-5 h-5 text-primary" />}
        {!collapsed && (
          <button
            onClick={onToggle}
            className="p-1.5 rounded-md text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
            aria-label="Recolher menu"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 min-h-0 overflow-y-auto py-2">
        {sectionsWithBadges.map((section) => {
          // Sales-only restriction: only show "Vendas" section
          if (isSalesOnly && section.title !== 'Vendas') return null;

          const visibleItems = section.items.filter(item => !item.managerOnly || isStaff);
          if (visibleItems.length === 0) return null;

          return (
            <div key={section.title} className="mb-1">
              {!collapsed && (
                <div className="px-3 py-1.5">
                  <span className="text-2xs font-medium uppercase tracking-wider text-sidebar-muted">
                    {section.title}
                  </span>
                </div>
              )}
              {collapsed && <div className="my-1 mx-2 border-t border-sidebar-border/50" />}
              {visibleItems.map((item) => {
                const active = isActive(item.path);
                const Icon = item.icon;

                const button = (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    className={cn(
                      'flex items-center gap-2.5 w-full rounded-md text-sm font-medium transition-colors',
                      collapsed ? 'justify-center px-2 py-2 mx-1' : 'px-3 py-1.5 mx-2',
                      active
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
                    )}
                  >
                    <Icon className={cn('shrink-0', collapsed ? 'w-5 h-5' : 'w-4 h-4')} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {!collapsed && item.badge && item.badge > 0 && (
                      <span className="ml-auto text-2xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                        {item.badge}
                      </span>
                    )}
                  </button>
                );

                if (collapsed) {
                  return (
                    <Tooltip key={item.path} delayDuration={0}>
                      <TooltipTrigger asChild>{button}</TooltipTrigger>
                      <TooltipContent side="right" className="font-medium">
                        {item.label}
                      </TooltipContent>
                    </Tooltip>
                  );
                }

                return <React.Fragment key={item.path}>{button}</React.Fragment>;
              })}
            </div>
          );
        })}
      </nav>

      {/* Collapse trigger at bottom when collapsed */}
      {collapsed && (
        <div className="border-t border-sidebar-border p-2">
          <button
            onClick={onToggle}
            className="w-full p-1.5 rounded-md text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors flex justify-center"
            aria-label="Expandir menu"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </aside>
  );
}

/* ─── Topbar ─── */
function AppTopbar({ sidebarCollapsed, onMobileMenuToggle }: { sidebarCollapsed: boolean; onMobileMenuToggle: () => void }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  return (
    <header
      className={cn(
        'fixed top-0 right-0 z-30 h-topbar border-b border-border bg-card/80 backdrop-blur-sm flex items-center justify-between px-4 transition-all duration-200',
        'left-0 lg:left-sidebar',
        sidebarCollapsed && 'lg:left-sidebar-collapsed'
      )}
    >
      {/* Mobile menu */}
      <button
        onClick={onMobileMenuToggle}
        className="lg:hidden p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        aria-label="Menu"
      >
        <Menu className="w-5 h-5" />
      </button>


      <div className="flex items-center gap-1">
        <HelpDrawer />
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
          <Bell className="w-4 h-4" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
              <User className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => navigate('/profile')}>
              <User className="w-4 h-4 mr-2" /> Meu perfil
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()} className="text-destructive">
              <LogOut className="w-4 h-4 mr-2" /> Sair
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/* ─── Mobile overlay ─── */
function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isStaff } = useUserRole();
  const isSalesOnly = useSalesOnlyRestriction();

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 lg:hidden" onClick={onClose} />
      <div className="fixed left-0 top-0 bottom-0 z-50 flex w-64 flex-col overflow-hidden bg-sidebar border-r border-sidebar-border lg:hidden animate-slide-in-right">
        <div className="flex items-center justify-between h-topbar border-b border-sidebar-border px-3">
          <div className="flex items-center gap-2">
            <Scissors className="w-5 h-5 text-primary" />
            <span className="text-sidebar-primary-foreground font-semibold text-lg">Central</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-sidebar-muted hover:text-sidebar-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto py-2">
          {[...unifiedNavSections, docNavSection].map((section) => {
            if (isSalesOnly && section.title !== 'Vendas') return null;
            const visibleItems = section.items.filter(item => !item.managerOnly || isStaff);
            if (visibleItems.length === 0) return null;
            return (
              <div key={section.title} className="mb-1">
                <div className="px-3 py-1.5">
                  <span className="text-2xs font-medium uppercase tracking-wider text-sidebar-muted">
                    {section.title}
                  </span>
                </div>
                {visibleItems.map((item) => {
                  const active = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.path}
                      onClick={() => { navigate(item.path); onClose(); }}
                      className={cn(
                        'flex items-center gap-2.5 w-full px-3 py-1.5 mx-2 rounded-md text-sm font-medium transition-colors',
                        active
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent/60'
                      )}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>
      </div>
    </>
  );
}

/* ─── Main Shell ─── */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <AppShellProvider>
    <div className="min-h-screen bg-background density-compact">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      </div>

      {/* Mobile nav */}
      <MobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />

      {/* Topbar */}
      <AppTopbar sidebarCollapsed={collapsed} onMobileMenuToggle={() => setMobileOpen(true)} />

      {/* Main content */}
      <main
        className={cn(
          'pt-topbar min-h-screen transition-all duration-200',
          'lg:ml-sidebar',
          collapsed && 'lg:ml-sidebar-collapsed'
        )}
      >
        <div className="p-4 lg:p-6">
          {children}
        </div>
      </main>
    </div>
    </AppShellProvider>
  );
}
