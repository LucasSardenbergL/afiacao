import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, Lock, Calculator, FileText, Palette, Beaker, FileUp, Droplets, LayoutDashboard, Users, ShoppingCart, Phone, GraduationCap, BarChart3, Settings, ChevronLeft, ChevronRight, Search, Bell, User, LogOut, Package, TrendingUp, Headphones, Target, Menu, X, ClipboardList, PlusCircle, Shield, Wrench, Award, Scissors, DollarSign, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { AppShellProvider } from '@/contexts/AppShellContext';
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
      { icon: TrendingUp, label: 'Recomendações', path: '/farmer/recommendations' },
      { icon: Target, label: 'Bundles', path: '/farmer/bundles' },
    ],
  },
  {
    title: 'Performance',
    items: [
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
    ],
  },
  {
    title: 'Gestão',
    items: [
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
    { icon: BookOpen, label: 'Design System', path: '/design-system' },
    { icon: BookOpen, label: 'UX Rules', path: '/ux-rules' },
  ],
};

/* ─── Sidebar ─── */
function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isStaff } = useUserRole();

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
        {[...unifiedNavSections, docNavSection].map((section) => {
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

      {/* Search hint */}
      <button
        className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-muted/50 text-muted-foreground text-sm hover:bg-muted transition-colors max-w-xs"
        onClick={() => {/* TODO: command palette */}}
      >
        <Search className="w-3.5 h-3.5" />
        <span>Buscar...</span>
        <kbd className="hidden lg:inline text-2xs bg-background border border-border rounded px-1.5 py-0.5 ml-auto font-mono">
          ⌘K
        </kbd>
      </button>

      <div className="flex items-center gap-1">
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
