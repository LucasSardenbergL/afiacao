import React, { useState, useEffect } from 'react';
import { ImpersonationBanner } from '@/components/impersonation/ImpersonationBanner';
import { useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, Lock, Calculator, Palette, LayoutDashboard, Users, ShoppingCart, Phone, BarChart3, Settings, ChevronLeft, ChevronRight, Bell, User, LogOut, Package, TrendingUp, Target, Menu, X, PlusCircle, Shield, Wrench, Award, DollarSign, UserCheck, FileCheck, Factory, Percent, Database, Library, Crosshair, ListChecks, Landmark, UserX, ShieldCheck, MessageCircle, MessageSquareText, ClipboardList, History, Lightbulb, Radar, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
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
import { MelhoriasPopover } from '@/components/melhorias/MelhoriasPopover';
import { useMelhoriasBadge } from '@/hooks/useMelhorias';
import { useAlertasCriticos } from '@/hooks/useAlertasCriticos';
import { useFinanceiroAlertas } from '@/hooks/useFinanceiroAlertas';
import { useTintAlertas } from '@/hooks/useTintAlertas';
import { useOportunidadesAtivasCount } from '@/hooks/useReposicaoSessao';
import { ShortcutsRegistryProvider } from '@/components/shell/ShortcutsRegistry';
import { ShortcutsDialog } from '@/components/shell/ShortcutsDialog';
import { CommandsRegistryProvider } from '@/components/shell/CommandsRegistry';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { CommandPaletteTrigger } from '@/components/shell/CommandPaletteTrigger';
import { CompanySwitcher } from '@/components/shell/CompanySwitcher';
import { PersonaSwitcherChip } from '@/components/dashboard/PersonaSwitcherChip';
import { ActiveOverrideBadge } from '@/components/financeiro/ActiveOverrideBadge';
import { NetworkStatusIndicator } from '@/components/shell/NetworkStatusIndicator';
import { DataHealthBadge } from '@/components/shell/DataHealthBadge';
import { ThemeToggle } from '@/components/shell/ThemeToggle';
import { PageViewTracker } from '@/components/shell/PageViewTracker';
import { AnalyticsIdentify } from '@/components/shell/AnalyticsIdentify';
import { GlobalBreadcrumbs } from "@/components/shell/GlobalBreadcrumbs";
import { useFeatureFlagBodyClass } from '@/hooks/useFeatureFlag';
import { useSidebarFavorites } from '@/hooks/useSidebarFavorites';
import { useSalesOnlyRestriction } from '@/hooks/useSalesOnlyRestriction';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { itemVisivelParaSalesOnly, SECAO_VENDAS } from '@/lib/nav/home-por-persona';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useRouteTracker } from '@/lib/dashboard/route-tracker';
import { useOfflineFlush } from '@/hooks/useOfflineFlush';
import { registerAllOfflineHandlers } from '@/lib/offline-handlers';
import { useMissedCount } from '@/hooks/useCallLog';
import { useMinhasTarefas } from '@/hooks/useTarefas';
import { useWhatsappSlaBadge } from '@/queries/useWhatsappSla';
import { Star } from 'lucide-react';

/* ─── Navigation config ─── */
interface NavItem {
  icon: React.ElementType;
  label: string;
  path: string;
  badge?: number;
  badgeVariant?: 'default' | 'destructive';
  /** Visível a QUALQUER staff (employee/master). Era `managerOnly` — nome mentiroso. */
  staffOnly?: boolean;
  masterOnly?: boolean;
  /** Visível apenas a gestor comercial (gerencial/estrategico/super_admin) OU master. */
  gestorComercialOuMaster?: boolean;
}

const unifiedNavSections: { title: string; items: NavItem[] }[] = [
  {
    title: 'Principal',
    items: [
      { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
      { icon: Target, label: 'Meu dia', path: '/meu-dia' },
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
    title: SECAO_VENDAS,
    // Ordem = fluxo do dia da vendedora: ligar (rota D-1) → responder (WhatsApp) →
    // vender (novo pedido) → acompanhar (pedidos). Secundários (telefone/hub) depois.
    // Enxugado p/ a vendedora não se perder (decisão Lucas, 2026-06-11):
    //  • "Lista de ligação" → "Quem ligar hoje" (nome auto-explicativo do trabalho do dia).
    //  • "Chamadas pendentes" SAIU daqui → virou nudge condicional no Meu Dia
    //    (FarmerDashboardV2) — é housekeeping, só aparece quando há o que vincular.
    //  • "Preview propostas" é tela TÉCNICA de inspeção das propostas que a IA gera
    //    no WhatsApp → restrita a gestor/master (a vendedora não a usa).
    items: [
      { icon: ListChecks, label: 'Quem ligar hoje', path: '/rota/ligacoes', staffOnly: true },
      { icon: MessageCircle, label: 'WhatsApp', path: '/whatsapp', staffOnly: true },
      { icon: PlusCircle, label: 'Novo pedido', path: '/sales/new' },
      { icon: ShoppingCart, label: 'Pedidos', path: '/sales' },
      { icon: Phone, label: 'Telefonia', path: '/telefonia' },
      { icon: Wrench, label: 'Ferramentas de venda', path: '/vendas/ferramentas' },
      { icon: ClipboardList, label: 'Tarefas', path: '/tarefas', gestorComercialOuMaster: true },
      { icon: ListChecks, label: 'Tarefas recorrentes', path: '/tarefas/templates', gestorComercialOuMaster: true },
      { icon: MessageSquareText, label: 'Preview propostas', path: '/rota/propostas', gestorComercialOuMaster: true },
    ],
  },
  {
    title: 'Estoque',
    items: [
      { icon: FileCheck, label: 'Recebimento', path: '/admin/estoque/recebimento' },
      { icon: Package, label: 'Picking & Estoque', path: '/admin/estoque/picking' },
    ],
  },
  {
    title: 'Reposição',
    items: [
      { icon: LayoutDashboard, label: 'Cockpit', path: '/admin/reposicao/sessao', staffOnly: true },
      { icon: TrendingUp, label: 'Mercado', path: '/admin/reposicao/sessao/mercado', staffOnly: true },
      { icon: Settings, label: 'Parâmetros', path: '/admin/reposicao/sessao/parametros', staffOnly: true },
      { icon: Database, label: 'Cadastros', path: '/admin/reposicao/cadastros', staffOnly: true },
      { icon: Package, label: 'Embalagem econômica', path: '/admin/reposicao/embalagem', staffOnly: true },
      { icon: History, label: 'Mudanças automáticas', path: '/admin/reposicao/mudancas-automaticas', staffOnly: true },
      { icon: AlertTriangle, label: 'Baixo giro', path: '/admin/reposicao/baixo-giro', staffOnly: true },
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
      { icon: BarChart3, label: 'Performance', path: '/performance' },
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
      { icon: Shield, label: 'Cockpit CFO', path: '/financeiro/cockpit', staffOnly: true },
      { icon: DollarSign, label: 'Gestão Financeira', path: '/financeiro/gestao', staffOnly: true },
      { icon: BarChart3, label: 'Análise e Config', path: '/financeiro/analise', staffOnly: true },
      { icon: Target, label: 'Orçamento', path: '/financeiro/orcamento', staffOnly: true },
      { icon: TrendingUp, label: 'Retorno & Valor', path: '/financeiro/valor', masterOnly: true },
      { icon: Percent, label: 'Regime Tributário', path: '/financeiro/regime-tributario', masterOnly: true },
      { icon: Landmark, label: 'Custo de Funding', path: '/financeiro/funding', masterOnly: true },
      { icon: Crosshair, label: 'Cockpit de Valor', path: '/financeiro/valor-cockpit', gestorComercialOuMaster: true },
      { icon: ListChecks, label: 'Próxima Ação', path: '/financeiro/proxima-acao', gestorComercialOuMaster: true },
    ],
  },
  {
    title: 'Tintométrico',
    items: [
      { icon: BarChart3, label: 'Dashboard', path: '/tintometrico', staffOnly: true },
      { icon: Palette, label: 'Catálogo e Preços', path: '/tintometrico/catalogo', staffOnly: true },
      { icon: Settings, label: 'Integração e Sync', path: '/tintometrico/integracao', staffOnly: true },
    ],
  },
  {
    title: 'Automação',
    items: [
      { icon: Bell, label: 'Notificações', path: '/admin/notificacoes', staffOnly: true },
    ],
  },
  {
    title: 'Gestão',
    items: [
      { icon: UserCheck, label: 'Liberar Acessos', path: '/admin/approvals', staffOnly: true },
      { icon: Users, label: 'Departamentos', path: '/admin/departments', staffOnly: true },
      { icon: UserX, label: 'Clientes não-vinculados', path: '/admin/clientes-nao-vinculados', gestorComercialOuMaster: true },
      { icon: Users, label: 'Grupos de Cliente', path: '/gestao/grupos-cliente', gestorComercialOuMaster: true },
      { icon: Radar, label: 'Radar de Clientes', path: '/radar', gestorComercialOuMaster: true },
      { icon: Library, label: 'Base de conhecimento', path: '/admin/knowledge-base', staffOnly: true },
      { icon: Calculator, label: 'Calculadora de rendimento', path: '/admin/calculadora' },
      { icon: Factory, label: 'Processos padrão', path: '/admin/standard-processes' },
      { icon: Shield, label: 'Admin & Relatórios', path: '/gestao/admin', staffOnly: true },
      { icon: Lock, label: 'Governança', path: '/gestao/governanca', staffOnly: true },
      { icon: ShieldCheck, label: 'Saúde de Dados', path: '/gestao/saude-dados', gestorComercialOuMaster: true },
      { icon: MessageCircle, label: 'SLA WhatsApp', path: '/whatsapp/sla', gestorComercialOuMaster: true },
      { icon: Lightbulb, label: 'Melhorias (fila)', path: '/gestao/melhorias', masterOnly: true },
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

/* ─── Sidebar — seções secundárias colapsadas por padrão ─── */
const SECONDARY_SECTIONS = ['Performance', 'Inteligência', 'Automação', 'Documentação'];

function SidebarSection({
  title,
  collapsed,
  defaultOpen,
  isActive,
  navigate,
  items,
  onToggleFavorite,
  isFavorite,
}: {
  title: string;
  collapsed: boolean;
  defaultOpen: boolean;
  isActive: (path: string) => boolean;
  navigate: ReturnType<typeof useNavigate>;
  items: NavItem[];
  onToggleFavorite?: (path: string) => void;
  isFavorite?: (path: string) => boolean;
}) {
  // Persistência localStorage do estado de cada seção pra preservar entre sessões
  const storageKey = `sidebar-section-${title}`;
  const [open, setOpen] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultOpen;
    const stored = window.localStorage.getItem(storageKey);
    return stored === null ? defaultOpen : stored === '1';
  });

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, open ? '1' : '0');
    }
  }, [open, storageKey]);

  // Em modo collapsed, mostra todos sem agrupador (tooltip dá o nome)
  if (collapsed) {
    return (
      <div className="mb-1">
        <div className="my-1 mx-2 border-t border-sidebar-border/50" />
        {items.map((item) => (
          <SidebarItem
            key={item.path}
            item={item}
            active={isActive(item.path)}
            navigate={navigate}
            collapsed
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 group"
      >
        <span className="text-2xs font-medium uppercase tracking-wider text-sidebar-muted group-hover:text-sidebar-foreground transition-colors">
          {title}
        </span>
        <ChevronRight
          className={cn(
            'w-3 h-3 text-sidebar-muted transition-transform group-hover:text-sidebar-foreground',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        // stagger-children dá fade-in cascateado quando a seção expande
        <div className="stagger-children">
          {items.map((item) => (
            <SidebarItem
              key={item.path}
              item={item}
              active={isActive(item.path)}
              navigate={navigate}
              collapsed={false}
              onToggleFavorite={onToggleFavorite}
              isFavorite={isFavorite?.(item.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarItem({
  item,
  active,
  navigate,
  collapsed,
  onToggleFavorite,
  isFavorite,
}: {
  item: NavItem;
  active: boolean;
  navigate: ReturnType<typeof useNavigate>;
  collapsed: boolean;
  onToggleFavorite?: (path: string) => void;
  isFavorite?: boolean;
}) {
  const Icon = item.icon;
  const showStar = !collapsed && onToggleFavorite;
  const button = (
    <div
      className={cn(
        'group/item relative flex items-center w-full',
        collapsed ? 'justify-center mx-1' : 'mx-2',
      )}
    >
      <button
        onClick={() => navigate(item.path)}
        className={cn(
          'flex items-center gap-2.5 w-full rounded-md text-sm font-medium transition-colors',
          collapsed ? 'justify-center px-2 py-2' : 'px-3 py-1.5',
          active
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
        )}
      >
        <Icon className={cn('shrink-0', collapsed ? 'w-5 h-5' : 'w-4 h-4')} />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {!collapsed && item.badge && item.badge > 0 && (
          <span className={cn(
            'ml-auto text-2xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center tabular-nums',
            item.badgeVariant === 'destructive'
              ? 'bg-destructive text-destructive-foreground'
              : 'bg-primary text-primary-foreground'
          )}>
            {item.badge}
          </span>
        )}
      </button>
      {showStar && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorite!(item.path); }}
          className={cn(
            'absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md transition-opacity',
            isFavorite
              ? 'opacity-100 text-status-warning-bold'
              : 'opacity-0 group-hover/item:opacity-60 hover:opacity-100 text-sidebar-muted',
          )}
          aria-label={isFavorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
        >
          <Star className={cn('w-3 h-3', isFavorite && 'fill-current')} />
        </button>
      )}
    </div>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }
  return button;
}

function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isStaff, isMaster, user } = useAuth();
  const isSalesOnly = useSalesOnlyRestriction();
  const { displayIsStaff, displayIsMaster, displayIsGestorComercial, displayIsSalesOnly, displayLoading } = useDisplayAccess();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const { favorites, isFavorite, toggle: toggleFavorite } = useSidebarFavorites();

  // Gate único de TODOS os polls de badge do shell (Reposição, outliers,
  // financeiro, tint): cliente final e vendedor sales-only não acessam essas
  // telas — sem o gate eles polavam tabelas que a RLS nega a cada 30-60s
  // (com retry 2 = até 9 req/min desperdiçados por usuário em idle).
  // `refetchIntervalInBackground: false` (default do React Query) já pausa
  // polls quando o tab está hidden — explicitado abaixo pra deixar a intenção
  // clara e evitar mudança silenciosa se algum dia alguém ligar pra true.
  const enableStaffPolls = isStaff && !isSalesOnly;

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
    enabled: enableStaffPolls,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
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
    enabled: enableStaffPolls,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    staleTime: 15000,
  });

  // Contador de aumentos ativos aguardando vigência
  // (corrige bug: faltava `enabled` — antes polava pra customer também)
  const { data: aumentosAtivos } = useQuery({
    queryKey: ['aumentos-ativos-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('fornecedor_aumento_anunciado')
        .select('*', { count: 'exact', head: true })
        .eq('estado', 'ativo');
      return count ?? 0;
    },
    enabled: enableStaffPolls,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
  });

  // Contador de oportunidades econômicas ativas hoje (OBEN) — fonte compartilhada
  // com o cockpit (useReposicaoStatus) via mesma queryKey → o react-query DEDUPLICA
  // (1 request/60s na view cara, antes eram 2). Degrada honesto p/ null em erro →
  // badge oculto, não fabrica "0". Detalhe em useReposicaoSessao.ts.
  const { data: oportunidadesAtivas } = useOportunidadesAtivasCount({ enabled: enableStaffPolls });

  // Contador de sugestões novas de negociação paralela (OBEN)
  const { data: negociacaoNovasCount } = useQuery({
    queryKey: ['negociacao-paralela-sugestoes-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('v_sugestao_negociacao_ativa')
        .select('*', { count: 'exact', head: true })
        .eq('empresa', 'OBEN')
        .eq('status', 'nova');
      return count ?? 0;
    },
    enabled: enableStaffPolls,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
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
    enabled: enableStaffPolls,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 30000,
  });

  const { data: alertasCriticos } = useAlertasCriticos(enableStaffPolls);
  const { data: financeiroAtrasados } = useFinanceiroAlertas(enableStaffPolls);
  const { data: tintErros } = useTintAlertas(enableStaffPolls);

  // Badge de perdidas não-lidas na Central de Telefonia (refetch a cada 30s).
  // Na lente "Ver como", conta as do ALVO (effectiveUserId) — coerente com o
  // histórico da própria tela; fora da lente é o próprio usuário.
  const { data: missedCallsCount } = useMissedCount(effectiveUserId ?? undefined);

  // Badge de tarefas abertas da vendedora (reusa useMinhasTarefas → mesmo
  // cache do card de "Meu dia": 1 request, 2 consumidores; refetch 60s +
  // invalidação nas mutations do módulo mantêm badge e card sempre iguais).
  const { data: minhasTarefas } = useMinhasTarefas();
  const tarefasCount = minhasTarefas?.length ?? 0;

  // Badge vermelho de WhatsApp: clientes MEUS com SLA vencido (vermelho).
  // Compartilha a queryKey/cache do useWhatsappSla (dado consistente com o
  // card/inbox; realtime das telas ricas atualiza o badge). Gate `isStaff`
  // SEM o !isSalesOnly do enableStaffPolls: a vendedora sales-only VÊ o item
  // /whatsapp (allowlist) e é justamente o público-alvo do SLA (#587) — o
  // poll dela é 1 view/60s que ela já paga ao abrir o inbox.
  const { data: waSlaMeusVermelhos } = useWhatsappSlaBadge(user?.id, isStaff);

  // Badge de melhorias abertas: a fila é master-only (item de nav masterOnly),
  // então o poll só roda pro master REAL — um employee polando contaria só os
  // PRÓPRIOS abertos (RLS) e mostraria badge errado.
  const { data: melhoriasAbertas } = useMelhoriasBadge(enableStaffPolls && isMaster);

  const sectionsWithBadges = React.useMemo(
    () => [...unifiedNavSections, docNavSection].map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (isImpersonating) return it; // na lente, sem badges (refletiriam dado do master)
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
        if (it.path === '/admin/reposicao/sessao/parametros' && alertasCriticos && alertasCriticos > 0) {
          return { ...it, badge: alertasCriticos, badgeVariant: 'destructive' as const };
        }
        if (it.path === '/financeiro/gestao' && financeiroAtrasados && financeiroAtrasados > 0) {
          return { ...it, badge: financeiroAtrasados, badgeVariant: 'destructive' as const };
        }
        if (it.path === '/tintometrico' && tintErros && tintErros > 0) {
          return { ...it, badge: tintErros, badgeVariant: 'destructive' as const };
        }
        if (it.path === '/telefonia' && missedCallsCount && missedCallsCount > 0) {
          return { ...it, badge: missedCallsCount, badgeVariant: 'destructive' as const };
        }
        if (it.path === '/meu-dia' && tarefasCount > 0) {
          return { ...it, badge: tarefasCount };
        }
        if (it.path === '/whatsapp' && waSlaMeusVermelhos && waSlaMeusVermelhos > 0) {
          return { ...it, badge: waSlaMeusVermelhos, badgeVariant: 'destructive' as const };
        }
        if (it.path === '/gestao/melhorias' && melhoriasAbertas && melhoriasAbertas > 0) {
          return { ...it, badge: melhoriasAbertas };
        }
        return it;
      }),
    })),
    [outlierPendentes, pedidosPendentes, aumentosAtivos, oportunidadesAtivas, negociacaoNovasCount, notificacoesPendentes, alertasCriticos, financeiroAtrasados, tintErros, missedCallsCount, tarefasCount, waSlaMeusVermelhos, melhoriasAbertas, isImpersonating],
  );

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <aside
      className={cn(
        'fixed left-0 bottom-0 z-40 flex flex-col overflow-hidden bg-sidebar border-r border-sidebar-border transition-all duration-200',
        isImpersonating ? 'top-7' : 'top-0',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar'
      )}
    >
      {/* Logo — wordmark "Colacor" refinado: peso 500 + tracking -0.045em + underline gradient
         O underline é a "spine" visual do app — gradient sutil que distingue Colacor de
         qualquer template Vercel genérico. Aparece só na sidebar expandida. */}
      <div className={cn(
        'flex items-center h-topbar border-b border-sidebar-border px-3',
        collapsed ? 'justify-center' : 'justify-between'
      )}>
        {!collapsed && (
          <div className="flex items-baseline gap-0.5 group">
            <span
              className="text-foreground text-base"
              style={{ fontWeight: 500, letterSpacing: '-0.045em' }}
            >
              Colacor
            </span>
            <span
              aria-hidden
              className="ml-0.5 inline-block w-1 h-1 rounded-full bg-gradient-to-br from-foreground to-status-info self-end mb-1.5 group-hover:scale-125 transition-transform"
            />
          </div>
        )}
        {collapsed && (
          <div className="w-7 h-7 rounded-md bg-foreground text-background flex items-center justify-center text-sm" style={{ fontWeight: 500, letterSpacing: '-0.04em' }}>
            C
          </div>
        )}
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

      {/* Navigation — Favoritos no topo (se houver) + seções secundárias colapsadas por padrão */}
      <nav className="flex-1 min-h-0 overflow-y-auto py-2">
        {/* Lente carregando o perfil do alvo: placeholder em vez de menu parcial
            (sem isso, durante o load apareceriam itens sem gate por um instante). */}
        {displayLoading ? (
          <div className="px-3 py-2">
            <span className="text-2xs font-medium uppercase tracking-wider text-sidebar-muted animate-pulse">
              {collapsed ? '…' : 'Carregando visão…'}
            </span>
          </div>
        ) : (
          <>
        {/* Favoritos pinados — coletados de todas as seções pelo path */}
        {!displayIsSalesOnly && favorites.length > 0 && !collapsed && (
          <SidebarSection
            title="Favoritos"
            collapsed={false}
            defaultOpen={true}
            isActive={isActive}
            navigate={navigate}
            items={
              sectionsWithBadges
                .flatMap((s) => s.items)
                .filter((item) => favorites.includes(item.path))
                .filter((item) => (!item.staffOnly || displayIsStaff) && (!item.masterOnly || displayIsMaster) && (!item.gestorComercialOuMaster || displayIsMaster || displayIsGestorComercial))
            }
            onToggleFavorite={toggleFavorite}
            isFavorite={isFavorite}
          />
        )}

        {sectionsWithBadges.map((section) => {
          // Sales-only filtra por ITEM (allowlist: seção Vendas + Meu dia + Clientes),
          // não mais por título de seção — senão o Meu Dia ficava inalcançável.
          const visibleItems = section.items.filter(item =>
            (!displayIsSalesOnly || itemVisivelParaSalesOnly(section.title, item.path)) &&
            (!item.staffOnly || displayIsStaff) && (!item.masterOnly || displayIsMaster) && (!item.gestorComercialOuMaster || displayIsMaster || displayIsGestorComercial));
          if (visibleItems.length === 0) return null;

          const isSecondary = SECONDARY_SECTIONS.includes(section.title);

          return (
            <SidebarSection
              key={section.title}
              title={section.title}
              collapsed={collapsed}
              defaultOpen={!isSecondary}
              isActive={isActive}
              navigate={navigate}
              items={visibleItems}
              onToggleFavorite={toggleFavorite}
              isFavorite={isFavorite}
            />
          );
        })}
          </>
        )}
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
  const { signOut } = useAuth();
  const { isImpersonating } = useImpersonation();
  const { displayIsStaff } = useDisplayAccess();

  return (
    <header
      className={cn(
        'fixed right-0 z-30 h-topbar border-b border-border bg-card/80 backdrop-blur-sm flex items-center justify-between px-4 transition-all duration-200',
        'left-0 lg:left-sidebar',
        isImpersonating ? 'top-7' : 'top-0',
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

      {/* Centro: trigger do command palette (descoberta visual do Cmd+K) */}
      <div className="flex-1 flex items-center justify-center px-4">
        <CommandPaletteTrigger />
      </div>

      <div className="flex items-center gap-1">
        <ActiveOverrideBadge />
        <PersonaSwitcherChip />
        <CompanySwitcher />
        <NetworkStatusIndicator />
        <DataHealthBadge />
        <ThemeToggle />
        {displayIsStaff && <MelhoriasPopover />}
        <HelpDrawer />

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
  const { displayIsStaff: isStaff, displayIsMaster: isMaster, displayIsGestorComercial: isGestorComercial, displayIsSalesOnly: isSalesOnly, displayLoading } = useDisplayAccess();

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 lg:hidden" onClick={onClose} />
      <div className="fixed left-0 top-0 bottom-0 z-50 flex w-64 flex-col overflow-hidden bg-sidebar border-r border-sidebar-border lg:hidden animate-slide-in-right">
        <div className="flex items-center justify-between h-topbar border-b border-sidebar-border px-3">
          <div className="flex items-baseline gap-0.5">
            <span
              className="text-foreground text-base"
              style={{ fontWeight: 500, letterSpacing: '-0.045em' }}
            >
              Colacor
            </span>
            <span
              aria-hidden
              className="ml-0.5 inline-block w-1 h-1 rounded-full bg-gradient-to-br from-foreground to-status-info self-end mb-1.5"
            />
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-sidebar-muted hover:text-sidebar-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto py-2">
          {displayLoading ? (
            <div className="px-3 py-2">
              <span className="text-2xs font-medium uppercase tracking-wider text-sidebar-muted animate-pulse">
                Carregando visão…
              </span>
            </div>
          ) : (
          [...unifiedNavSections, docNavSection].map((section) => {
            // Espelha o filtro do desktop: sales-only por ITEM (allowlist), não por seção.
            const visibleItems = section.items.filter(item =>
              (!isSalesOnly || itemVisivelParaSalesOnly(section.title, item.path)) &&
              (!item.staffOnly || isStaff) && (!item.masterOnly || isMaster) && (!item.gestorComercialOuMaster || isMaster || isGestorComercial));
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
                        'flex min-h-11 items-center gap-2.5 w-full px-3 py-2.5 mx-2 rounded-md text-sm font-medium transition-colors',
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
          }))}
        </nav>
      </div>
    </>
  );
}

/* ─── Main Shell ─── */
export function AppShell({ children }: { children: React.ReactNode }) {
  useRouteTracker();
  // Registra os handlers de flush ANTES do useOfflineFlush (que pode disparar flush no mount).
  useEffect(() => registerAllOfflineHandlers(), []);
  useOfflineFlush();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { isImpersonating } = useImpersonation();

  // Aplica .legacy-visual no <html> quando feature flag newVisual = false
  useFeatureFlagBodyClass('newVisual', 'legacy-visual', /* invert */ true);

  return (
    <AppShellProvider>
      <ShortcutsRegistryProvider>
        <CommandsRegistryProvider>
          <div className={cn('min-h-screen bg-background density-compact', isImpersonating && 'pt-7')}>
            <ImpersonationBanner />
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
                <GlobalBreadcrumbs />
                {children}
              </div>
            </main>

            {/* Overlays globais */}
            <CommandPalette />
            <ShortcutsDialog />

            {/* Telemetria — sem render visual, monta uma vez */}
            <PageViewTracker />
            <AnalyticsIdentify />
          </div>
        </CommandsRegistryProvider>
      </ShortcutsRegistryProvider>
    </AppShellProvider>
  );
}
