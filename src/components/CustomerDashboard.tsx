import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PlusCircle, ClipboardList, ChevronRight, Wrench, Calendar, User,
  ArrowRight, TrendingUp, Package, Trophy, Gamepad2,
  Sparkles, AlertTriangle, Award, CheckCircle2, MapPin,
  LifeBuoy, FileText
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { useGamificationScore, getLevelInfo } from '@/hooks/useGamificationScore';
import { differenceInDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

/* ─── Types ─── */
interface Profile {
  name: string;
  customer_type: string | null;
  document: string | null;
}

interface Order {
  id: string;
  status: string;
  created_at: string;
  service_type: string;
}

interface UserTool {
  id: string;
  tool_category_id: string;
  next_sharpening_due: string | null;
  sharpening_interval_days: number | null;
  tool_categories: { name: string };
}

interface CustomerDashboardProps {
  profile: Profile | null;
  pendingOrders: Order[];
  userTools: UserTool[];
  getGreeting: () => string;
}

/* ─── Status config ─── */
const statusConfig: Record<string, { label: string; statusClass: string }> = {
  'pedido_recebido': { label: 'Recebido', statusClass: 'status-progress' },
  'aguardando_coleta': { label: 'Aguardando Coleta', statusClass: 'status-pending' },
  'em_triagem': { label: 'Em Triagem', statusClass: 'status-purple' },
  'orcamento_enviado': { label: 'Orçamento', statusClass: 'status-pending' },
  'aprovado': { label: 'Aprovado', statusClass: 'status-success' },
  'em_afiacao': { label: 'Em Afiação', statusClass: 'status-progress' },
  'controle_qualidade': { label: 'Qualidade', statusClass: 'status-indigo' },
  'pronto_entrega': { label: 'Pronto!', statusClass: 'status-success' },
  'em_rota': { label: 'Em Rota', statusClass: 'status-indigo' },
  'entregue': { label: 'Entregue', statusClass: 'bg-muted text-muted-foreground' },
};

/* ─── Animations ─── */
const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] as const } },
};

/* ─── Priority Action Logic ─── */
interface PriorityAction {
  type: 'quote' | 'order_issue' | 'tools_overdue' | 'no_tools' | 'no_address' | 'all_good';
  title: string;
  description: string;
  buttonLabel?: string;
  path?: string;
  variant: 'warning' | 'destructive' | 'default' | 'success';
  icon: typeof AlertTriangle;
  orderId?: string;
}

function computePriority(
  pendingOrders: Order[],
  toolsOverdue: UserTool[],
  userTools: UserTool[],
  hasAddresses: boolean,
): PriorityAction {
  // 1. Pending quote
  const quoteOrder = pendingOrders.find(o => o.status === 'orcamento_enviado');
  if (quoteOrder) {
    return {
      type: 'quote', variant: 'warning', icon: FileText,
      title: 'Orçamento pendente de aprovação',
      description: 'Revise e aprove para que a afiação seja iniciada.',
      buttonLabel: 'Ver orçamento', path: `/orders/${quoteOrder.id}`,
      orderId: quoteOrder.id,
    };
  }

  // 2. Tools overdue
  if (toolsOverdue.length > 0) {
    return {
      type: 'tools_overdue', variant: 'destructive', icon: AlertTriangle,
      title: `${toolsOverdue.length} ferramenta(s) com afiação vencida`,
      description: 'Ferramentas fora do prazo podem perder o fio e danificar peças.',
      buttonLabel: 'Agendar afiação', path: '/new-order',
    };
  }

  // 3. No tools registered
  if (userTools.length === 0) {
    return {
      type: 'no_tools', variant: 'default', icon: Wrench,
      title: 'Cadastre suas ferramentas',
      description: 'Facilite seus pedidos e receba alertas de manutenção.',
      buttonLabel: 'Cadastrar', path: '/tools',
    };
  }

  // 4. No address
  if (!hasAddresses) {
    return {
      type: 'no_address', variant: 'default', icon: MapPin,
      title: 'Cadastre um endereço para agilizar coletas',
      description: 'Com um endereço salvo, seus pedidos ficam mais rápidos.',
      buttonLabel: 'Adicionar', path: '/addresses',
    };
  }

  // 5. All good
  return {
    type: 'all_good', variant: 'success', icon: CheckCircle2,
    title: 'Tudo em dia!',
    description: 'Suas ferramentas estão bem cuidadas.',
  };
}

/* ─── Component ─── */
export function CustomerDashboard({ profile, pendingOrders, userTools, getGreeting }: CustomerDashboardProps) {
  const navigate = useNavigate();
  const { data: gamScore } = useGamificationScore();

  const [hasAddresses, setHasAddresses] = useState(true); // optimistic default

  // Lightweight address check
  useEffect(() => {
    (async () => {
      const { count } = await supabase
        .from('addresses')
        .select('id', { count: 'exact', head: true });
      setHasAddresses((count ?? 0) > 0);
    })();
  }, []);

  const isCNPJ = profile?.document && profile.document.replace(/\D/g, '').length === 14;
  const displayName = isCNPJ ? profile?.name || 'Cliente' : profile?.name?.split(' ')[0] || 'Cliente';

  const toolsOverdue = userTools.filter(t => {
    if (!t.next_sharpening_due) return false;
    return differenceInDays(new Date(t.next_sharpening_due), new Date()) < 0;
  });
  const toolsSoon = userTools.filter(t => {
    if (!t.next_sharpening_due) return false;
    const d = differenceInDays(new Date(t.next_sharpening_due), new Date());
    return d >= 0 && d <= 7;
  });
  const urgentTools = [...toolsOverdue, ...toolsSoon];
  const levelInfo = gamScore ? getLevelInfo(gamScore.total_score) : null;

  const priority = computePriority(pendingOrders, toolsOverdue, userTools, hasAddresses);

  const ordersNeedingAction = pendingOrders.filter(o => o.status === 'orcamento_enviado');
  const otherActiveOrders = pendingOrders.filter(o => o.status !== 'orcamento_enviado');

  const quickActions = [
    { icon: PlusCircle, label: 'Novo Pedido', path: '/new-order' },
    { icon: Wrench, label: 'Ferramentas', path: '/tools' },
    { icon: Gamepad2, label: 'Gamificação', path: '/gamification' },
    { icon: LifeBuoy, label: 'Suporte', path: '/support' },
  ];

  return (
    <div className="space-y-6">
      {/* ─── Hero Header ─── */}
      <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-10 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-72 h-72 bg-primary/8 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-primary/5 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2" />
        <motion.div
          className="max-w-lg mx-auto relative z-10"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex items-start justify-between mb-6">
            <div className="space-y-1">
              <p className="text-sm text-secondary-foreground/60 font-medium">{getGreeting()},</p>
              <h1 className="text-2xl font-display font-bold tracking-tight">{displayName}</h1>
              {profile?.customer_type && (
                <span className={cn(
                  'inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-wider',
                  profile.customer_type === 'industrial'
                    ? 'bg-status-warning/20 text-status-warning-bg'
                    : 'bg-status-info/20 text-status-info-bg'
                )}>
                  {profile.customer_type === 'industrial' ? (
                    <><TrendingUp className="w-3 h-3" /> Industrial</>
                  ) : 'Doméstico'}
                </span>
              )}
            </div>
            <motion.button
              onClick={() => navigate('/profile')}
              className="w-12 h-12 rounded-2xl bg-secondary-foreground/10 hover:bg-secondary-foreground/20 flex items-center justify-center transition-colors border border-secondary-foreground/10"
              whileTap={{ scale: 0.92 }}
            >
              <User className="w-5 h-5 text-secondary-foreground/80" />
            </motion.button>
          </div>

          {/* Stats Row */}
          <motion.div className="grid grid-cols-3 gap-2" variants={stagger} initial="hidden" animate="show">
            {[
              { icon: Package, value: pendingOrders.length, label: 'Pedidos', path: '/orders' },
              { icon: Wrench, value: userTools.length, label: 'Ferramentas', path: '/tools' },
              { icon: Trophy, value: gamScore?.total_score || 0, label: 'Score', path: '/gamification' },
            ].map(stat => (
              <motion.button
                key={stat.label}
                variants={fadeUp}
                onClick={() => navigate(stat.path)}
                className="bg-secondary-foreground/8 hover:bg-secondary-foreground/14 rounded-2xl p-3 backdrop-blur-sm border border-secondary-foreground/5 transition-colors text-left group"
                whileTap={{ scale: 0.96 }}
              >
                <stat.icon className="w-4 h-4 text-secondary-foreground/50 mb-1" />
                <p className="text-2xl font-bold tracking-tight">{stat.value}</p>
                <p className="text-[10px] text-secondary-foreground/50 font-medium">{stat.label}</p>
              </motion.button>
            ))}
          </motion.div>
        </motion.div>
      </header>

      <motion.main
        className="px-4 -mt-5 max-w-lg mx-auto relative z-20 space-y-5"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        {/* Onboarding */}
        <OnboardingWizard hasTools={userTools.length > 0} hasOrders={pendingOrders.length > 0} />

        {/* ─── SEÇÃO 1: Ação Recomendada ─── */}
        <motion.div variants={fadeUp}>
          <PriorityCard priority={priority} navigate={navigate} />
        </motion.div>

        {/* Gamification Mini */}
        {gamScore && levelInfo && (
          <motion.div variants={fadeUp}>
            <Card
              className="shadow-medium border-0 overflow-hidden cursor-pointer hover:shadow-strong transition-shadow"
              onClick={() => navigate('/gamification')}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-status-warning-bg flex items-center justify-center flex-shrink-0">
                    <Award className="w-6 h-6 text-status-warning" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-sm text-foreground">
                        Nível {gamScore.level} — {gamScore.level_name}
                      </span>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <Progress value={gamScore.total_score} className="h-1.5" />
                    <div className="flex justify-between mt-1">
                      <span className="text-[10px] text-muted-foreground">{gamScore.total_score}/100 pts</span>
                      {levelInfo.nextLevel && (
                        <span className="text-[10px] text-muted-foreground">
                          Faltam {Math.ceil(levelInfo.nextLevel.min - gamScore.total_score)} para {levelInfo.nextLevel.name}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* ─── SEÇÃO 2: Pedidos em Andamento ─── */}
        {pendingOrders.length > 0 && (
          <motion.section variants={fadeUp}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display font-bold text-lg text-foreground">Pedidos em Andamento</h2>
              <button onClick={() => navigate('/orders')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
                Ver todos <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5">
              {/* Orders needing action first */}
              {ordersNeedingAction.map((order, i) => (
                <OrderRow key={order.id} order={order} index={i} navigate={navigate} needsAction />
              ))}
              {otherActiveOrders.slice(0, 3).map((order, i) => (
                <OrderRow key={order.id} order={order} index={ordersNeedingAction.length + i} navigate={navigate} />
              ))}
            </div>
          </motion.section>
        )}

        {/* ─── SEÇÃO 3: Ferramentas que Exigem Atenção ─── */}
        {urgentTools.length > 0 && (
          <motion.section variants={fadeUp}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display font-bold text-lg text-foreground">Ferramentas com Atenção</h2>
              <button onClick={() => navigate('/tools')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
                Gerenciar <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <Card className="border-status-warning/20 bg-status-warning-bg/50">
              <CardContent className="p-4 space-y-3">
                {urgentTools.slice(0, 4).map(tool => {
                  const days = differenceInDays(new Date(tool.next_sharpening_due!), new Date());
                  return (
                    <div key={tool.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center',
                          days < 0 ? 'bg-destructive/10' : 'bg-status-warning-bg'
                        )}>
                          <Wrench className={cn('w-4 h-4', days < 0 ? 'text-destructive' : 'text-status-warning')} />
                        </div>
                        <span className="text-sm font-medium text-foreground">{tool.tool_categories?.name}</span>
                      </div>
                      <span className={cn(
                        'text-xs font-semibold px-2 py-0.5 rounded-full',
                        days < 0 ? 'bg-destructive/10 text-destructive' : 'bg-status-warning-bg text-status-warning-foreground'
                      )}>
                        {days < 0 ? `${Math.abs(days)}d atrasado` : days === 0 ? 'Hoje' : `Em ${days}d`}
                      </span>
                    </div>
                  );
                })}
                <Button size="sm" className="w-full rounded-xl mt-1" onClick={() => navigate('/new-order')}>
                  <PlusCircle className="w-4 h-4 mr-1.5" />
                  Criar pedido
                </Button>
              </CardContent>
            </Card>
          </motion.section>
        )}

        {/* ─── SEÇÃO 4: Ações Rápidas ─── */}
        <motion.section variants={fadeUp}>
          <h2 className="font-display font-bold text-lg text-foreground mb-3">Ações Rápidas</h2>
          <div className="grid grid-cols-4 gap-2">
            {quickActions.map((item) => (
              <motion.button
                key={item.path}
                onClick={() => navigate(item.path)}
                className="bg-card rounded-2xl p-3 shadow-soft border border-border/80 hover:shadow-medium hover:border-primary/20 transition-all flex flex-col items-center gap-2 group"
                whileTap={{ scale: 0.95 }}
                whileHover={{ y: -2 }}
              >
                <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <item.icon className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <span className="text-[11px] font-semibold text-foreground text-center leading-tight">{item.label}</span>
              </motion.button>
            ))}
          </div>
        </motion.section>

        {/* Empty state for brand-new users */}
        {pendingOrders.length === 0 && userTools.length === 0 && priority.type !== 'no_tools' && (
          <motion.div variants={fadeUp}>
            <Card className="text-center py-8">
              <CardContent className="space-y-3">
                <Sparkles className="w-10 h-10 text-primary mx-auto" />
                <h3 className="font-semibold text-foreground">Bem-vindo à Colacor!</h3>
                <p className="text-sm text-muted-foreground">Faça seu primeiro pedido de afiação e mantenha suas ferramentas sempre afiadas.</p>
                <Button onClick={() => navigate('/new-order')} className="rounded-xl">
                  <PlusCircle className="w-4 h-4 mr-1.5" /> Criar Primeiro Pedido
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Industrial benefit */}
        {profile?.customer_type === 'industrial' && (
          <motion.section variants={fadeUp}>
            <Card className="bg-gradient-primary text-primary-foreground border-0 overflow-hidden">
              <CardContent className="p-5 relative">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2" />
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <TrendingUp className="w-5 h-5" />
                    <span className="font-semibold">Cliente Industrial</span>
                  </div>
                  <p className="text-sm text-primary-foreground/80">Você tem frete gratuito em todos os seus pedidos!</p>
                </div>
              </CardContent>
            </Card>
          </motion.section>
        )}
      </motion.main>
    </div>
  );
}

/* ─── Sub-components ─── */

function PriorityCard({ priority, navigate }: { priority: PriorityAction; navigate: ReturnType<typeof useNavigate> }) {
  const bgMap: Record<PriorityAction['variant'], string> = {
    warning: 'border-status-warning/30 bg-status-warning-bg/60',
    destructive: 'border-destructive/30 bg-destructive/5',
    default: 'border-border bg-card',
    success: 'border-primary/20 bg-primary/5',
  };
  const iconBgMap: Record<PriorityAction['variant'], string> = {
    warning: 'bg-status-warning-bg text-status-warning',
    destructive: 'bg-destructive/10 text-destructive',
    default: 'bg-muted text-muted-foreground',
    success: 'bg-primary/10 text-primary',
  };

  return (
    <Card className={cn('shadow-medium overflow-hidden', bgMap[priority.variant])}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', iconBgMap[priority.variant])}>
            <priority.icon className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-foreground mb-0.5">{priority.title}</h3>
            <p className="text-xs text-muted-foreground">{priority.description}</p>
          </div>
        </div>
        {priority.buttonLabel && priority.path && (
          <Button
            size="sm"
            className="w-full rounded-xl mt-3"
            variant={priority.variant === 'success' ? 'outline' : 'default'}
            onClick={() => navigate(priority.path!)}
          >
            {priority.buttonLabel}
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function OrderRow({ order, index, navigate, needsAction }: {
  order: Order; index: number; navigate: ReturnType<typeof useNavigate>; needsAction?: boolean;
}) {
  const config = statusConfig[order.status] || statusConfig['pedido_recebido'];
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
    >
      <Card
        className={cn(
          'overflow-hidden hover:shadow-medium transition-all cursor-pointer group border-border/60',
          needsAction && 'ring-1 ring-status-warning/40'
        )}
        onClick={() => navigate(`/orders/${order.id}`)}
      >
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center',
                needsAction ? 'bg-status-warning-bg' : 'bg-muted'
              )}>
                <Package className={cn('w-5 h-5', needsAction ? 'text-status-warning' : 'text-muted-foreground')} />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">
                  {format(new Date(order.created_at), "dd 'de' MMM", { locale: ptBR })}
                </p>
                <p className="text-xs text-muted-foreground capitalize">{order.service_type}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {needsAction && (
                <Badge variant="outline" className="text-[10px] border-status-warning text-status-warning bg-status-warning-bg font-semibold">
                  Ação necessária
                </Badge>
              )}
              <span className={cn('text-[11px] px-2.5 py-1 rounded-full font-semibold border', config.statusClass)}>
                {config.label}
              </span>
              <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
