import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  PlusCircle, ClipboardList, ChevronRight, Wrench, Calendar, User, 
  ArrowRight, TrendingUp, Package, CalendarClock, Trophy, Gamepad2,
  PiggyBank, Sparkles, AlertTriangle, BookOpen, Award
} from 'lucide-react';
import { Button } from '@/components/ui/button';

import { OnboardingWizard } from '@/components/OnboardingWizard';
import { EmptyState } from '@/components/EmptyState';
import { useGamificationScore, getLevelInfo } from '@/hooks/useGamificationScore';
import { differenceInDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

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
  tool_categories: {
    name: string;
  };
}

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

interface CustomerDashboardProps {
  profile: Profile | null;
  pendingOrders: Order[];
  userTools: UserTool[];
  getGreeting: () => string;
}

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] as const } },
};

export function CustomerDashboard({ profile, pendingOrders, userTools, getGreeting }: CustomerDashboardProps) {
  const navigate = useNavigate();
  const { data: gamScore, loading: gamLoading } = useGamificationScore();

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

  const quickActions = [
    { icon: ClipboardList, label: 'Pedidos', path: '/orders' },
    { icon: Wrench, label: 'Ferramentas', path: '/tools' },
    { icon: CalendarClock, label: 'Agendar', path: '/recurring-schedules' },
    { icon: PiggyBank, label: 'Economia', path: '/savings' },
    { icon: BookOpen, label: 'Treinar', path: '/training' },
    { icon: Gamepad2, label: 'Ranking', path: '/gamification' },
  ];

  return (
    <div className="space-y-6">
      {/* Hero Header */}
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
          <motion.div 
            className="grid grid-cols-3 gap-2"
            variants={stagger}
            initial="hidden"
            animate="show"
          >
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
        className="px-4 -mt-5 max-w-lg mx-auto relative z-20"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        {/* Onboarding for new users */}
        <OnboardingWizard hasTools={userTools.length > 0} hasOrders={pendingOrders.length > 0} />

        {/* Gamification Mini Card */}
        {gamScore && levelInfo && (
          <motion.div variants={fadeUp}>
            <Card 
              className="shadow-medium border-0 mb-4 overflow-hidden cursor-pointer hover:shadow-strong transition-shadow"
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

        {/* Urgent Tools Alert */}
        <AnimatePresence>
          {urgentTools.length > 0 && (
            <motion.div variants={fadeUp}>
              <Card className="border-status-warning/20 bg-status-warning-bg/80 mb-4">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-status-warning-bg flex items-center justify-center">
                      <AlertTriangle className="w-4 h-4 text-status-warning" />
                    </div>
                    <span className="font-semibold text-sm text-status-warning-foreground">
                      {toolsOverdue.length > 0 
                        ? `${toolsOverdue.length} ferramenta(s) com afiação atrasada`
                        : `${toolsSoon.length} ferramenta(s) precisam de afiação em breve`
                      }
                    </span>
                  </div>
                  <div className="space-y-2 mb-3">
                    {urgentTools.slice(0, 3).map(tool => {
                      const days = differenceInDays(new Date(tool.next_sharpening_due!), new Date());
                      return (
                        <div key={tool.id} className="flex items-center justify-between text-sm">
                          <span className="text-foreground">{tool.tool_categories?.name}</span>
                          <span className={cn(
                            'text-xs font-medium px-2 py-0.5 rounded-full',
                            days < 0 ? 'bg-destructive/10 text-destructive' : 'bg-status-warning-bg text-status-warning-foreground'
                          )}>
                            {days < 0 ? `${Math.abs(days)}d atrasado` : days === 0 ? 'Hoje' : `Em ${days}d`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <Button size="sm" className="w-full rounded-xl" onClick={() => navigate('/new-order')}>
                    <PlusCircle className="w-4 h-4 mr-1" />
                    Agendar afiação
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* CTA Novo Pedido */}
        <motion.div variants={fadeUp}>
          <Card className="shadow-medium border-0 mb-4 overflow-hidden">
            <CardContent className="p-0">
              <motion.button
                onClick={() => navigate('/new-order')}
                className="w-full p-5 flex items-center gap-4 group hover:bg-muted/30 transition-colors"
                whileTap={{ scale: 0.98 }}
              >
                <motion.div 
                  className="w-14 h-14 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-glow flex-shrink-0"
                  whileHover={{ scale: 1.06, rotate: 2 }}
                  transition={{ type: "spring", stiffness: 400 }}
                >
                  <PlusCircle className="w-7 h-7 text-primary-foreground" />
                </motion.div>
                <div className="flex-1 text-left">
                  <h2 className="font-display font-bold text-lg text-foreground">Novo Pedido de Afiação</h2>
                  <p className="text-sm text-muted-foreground">Agende a coleta das suas ferramentas</p>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:translate-x-1 group-hover:text-primary transition-all" />
              </motion.button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Quick Actions */}
        <motion.div variants={fadeUp} className="grid grid-cols-3 gap-2 mb-6">
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
              <span className="text-[11px] font-semibold text-foreground">{item.label}</span>
            </motion.button>
          ))}
        </motion.div>

        {/* Pending Orders */}
        {pendingOrders.length > 0 && (
          <motion.section variants={fadeUp} className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-bold text-lg text-foreground">Em Andamento</h2>
              <button onClick={() => navigate('/orders')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
                Ver todos <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5">
              {pendingOrders.slice(0, 3).map((order, index) => {
                const config = statusConfig[order.status] || statusConfig['pedido_recebido'];
                return (
                  <motion.div
                    key={order.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.06 }}
                  >
                    <Card 
                      className="overflow-hidden hover:shadow-medium transition-all cursor-pointer group border-border/60"
                      onClick={() => navigate(`/orders/${order.id}`)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                              <Package className="w-5 h-5 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="font-semibold text-sm text-foreground">
                                {format(new Date(order.created_at), "dd 'de' MMM", { locale: ptBR })}
                              </p>
                              <p className="text-xs text-muted-foreground capitalize">{order.service_type}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
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
              })}
            </div>
          </motion.section>
        )}

        {/* Tools preview with sharpening status */}
        {userTools.length > 0 && (
          <motion.section variants={fadeUp} className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-bold text-lg text-foreground">Minhas Ferramentas</h2>
              <button onClick={() => navigate('/tools')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
                Gerenciar <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {userTools.slice(0, 4).map((tool, index) => {
                const daysUntil = tool.next_sharpening_due 
                  ? differenceInDays(new Date(tool.next_sharpening_due), new Date()) : null;
                const needsSharpening = daysUntil !== null && daysUntil <= 7;
                return (
                  <motion.div
                    key={tool.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: index * 0.06 }}
                  >
                    <Card className={cn(
                      'border-border/60 hover:shadow-medium transition-all',
                      needsSharpening && 'ring-1 ring-status-warning/40 bg-status-warning-bg/50'
                    )}>
                      <CardContent className="p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', needsSharpening ? 'bg-status-warning-bg' : 'bg-muted')}>
                            <Wrench className={cn('w-4 h-4', needsSharpening ? 'text-status-warning' : 'text-muted-foreground')} />
                          </div>
                          <p className="font-semibold text-sm text-foreground truncate flex-1">{tool.tool_categories?.name}</p>
                        </div>
                        {tool.next_sharpening_due && (
                          <p className={cn('text-xs flex items-center gap-1', needsSharpening ? 'text-status-warning font-medium' : 'text-muted-foreground')}>
                            <Calendar className="w-3 h-3" />
                            {daysUntil !== null && daysUntil < 0 ? 'Atrasado' : daysUntil === 0 ? 'Hoje' : `Em ${daysUntil} dias`}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          </motion.section>
        )}

        {/* Empty state */}
        {pendingOrders.length === 0 && userTools.length === 0 && (
          <EmptyState
            icon={Sparkles}
            title="Bem-vindo à Colacor!"
            description="Faça seu primeiro pedido de afiação e mantenha suas ferramentas sempre afiadas"
            actionLabel="Criar Primeiro Pedido"
            onAction={() => navigate('/new-order')}
          />
        )}

        {/* Industrial benefit */}
        {profile?.customer_type === 'industrial' && (
          <motion.section variants={fadeUp} className="mt-6">
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
