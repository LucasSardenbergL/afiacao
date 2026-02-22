import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  PlusCircle, ClipboardList, ChevronRight, Wrench, Calendar, User, 
  ArrowRight, TrendingUp, Package, CalendarClock, Trophy, Gamepad2,
  PiggyBank, Sparkles, AlertTriangle, BookOpen, Award
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BottomNav } from '@/components/BottomNav';
import { OnboardingWizard } from '@/components/OnboardingWizard';
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

const statusConfig: Record<string, { label: string; color: string; bgColor: string }> = {
  'pedido_recebido': { label: 'Recebido', color: 'text-blue-700', bgColor: 'bg-blue-100' },
  'aguardando_coleta': { label: 'Aguardando Coleta', color: 'text-amber-700', bgColor: 'bg-amber-100' },
  'em_triagem': { label: 'Em Triagem', color: 'text-purple-700', bgColor: 'bg-purple-100' },
  'orcamento_enviado': { label: 'Orçamento', color: 'text-orange-700', bgColor: 'bg-orange-100' },
  'aprovado': { label: 'Aprovado', color: 'text-emerald-700', bgColor: 'bg-emerald-100' },
  'em_afiacao': { label: 'Em Afiação', color: 'text-primary', bgColor: 'bg-primary/10' },
  'controle_qualidade': { label: 'Qualidade', color: 'text-cyan-700', bgColor: 'bg-cyan-100' },
  'pronto_entrega': { label: 'Pronto!', color: 'text-emerald-700', bgColor: 'bg-emerald-100' },
  'em_rota': { label: 'Em Rota', color: 'text-indigo-700', bgColor: 'bg-indigo-100' },
  'entregue': { label: 'Entregue', color: 'text-muted-foreground', bgColor: 'bg-muted' },
};

interface CustomerDashboardProps {
  profile: Profile | null;
  pendingOrders: Order[];
  userTools: UserTool[];
  getGreeting: () => string;
}

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

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Hero Header */}
      <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-10 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-40 h-40 bg-primary/5 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2" />

        <div className="max-w-lg mx-auto relative z-10">
          <div className="flex items-start justify-between mb-6">
            <div className="space-y-1">
              <p className="text-sm text-secondary-foreground/70 font-medium">{getGreeting()},</p>
              <h1 className="text-2xl font-display font-bold tracking-tight">{displayName}</h1>
              {profile?.customer_type && (
                <span className={cn(
                  'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium',
                  profile.customer_type === 'industrial' 
                    ? 'bg-amber-500/20 text-amber-300' 
                    : 'bg-blue-500/20 text-blue-300'
                )}>
                  {profile.customer_type === 'industrial' ? (
                    <><TrendingUp className="w-3 h-3" /> Industrial</>
                  ) : 'Doméstico'}
                </span>
              )}
            </div>
            <button 
              onClick={() => navigate('/profile')}
              className="w-12 h-12 rounded-full bg-primary/90 hover:bg-primary flex items-center justify-center transition-all hover:scale-105 shadow-glow"
            >
              <User className="w-6 h-6 text-primary-foreground" />
            </button>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => navigate('/orders')}
              className="bg-secondary-foreground/10 hover:bg-secondary-foreground/15 rounded-2xl p-3 backdrop-blur-sm border border-secondary-foreground/5 transition-all text-left group"
            >
              <Package className="w-4 h-4 text-secondary-foreground/60 mb-1" />
              <p className="text-2xl font-bold">{pendingOrders.length}</p>
              <p className="text-[10px] text-secondary-foreground/60">Pedidos</p>
            </button>
            <button
              onClick={() => navigate('/tools')}
              className="bg-secondary-foreground/10 hover:bg-secondary-foreground/15 rounded-2xl p-3 backdrop-blur-sm border border-secondary-foreground/5 transition-all text-left group"
            >
              <Wrench className="w-4 h-4 text-secondary-foreground/60 mb-1" />
              <p className="text-2xl font-bold">{userTools.length}</p>
              <p className="text-[10px] text-secondary-foreground/60">Ferramentas</p>
            </button>
            <button
              onClick={() => navigate('/gamification')}
              className="bg-secondary-foreground/10 hover:bg-secondary-foreground/15 rounded-2xl p-3 backdrop-blur-sm border border-secondary-foreground/5 transition-all text-left group"
            >
              <Trophy className="w-4 h-4 text-secondary-foreground/60 mb-1" />
              <p className="text-2xl font-bold">{gamScore?.total_score || 0}</p>
              <p className="text-[10px] text-secondary-foreground/60">Score</p>
            </button>
          </div>
        </div>
      </header>

      <main className="px-4 -mt-5 max-w-lg mx-auto relative z-20">
        {/* Onboarding for new users */}
        <OnboardingWizard hasTools={userTools.length > 0} hasOrders={pendingOrders.length > 0} />

        {/* Gamification Mini Card */}
        {gamScore && levelInfo && (
          <Card 
            className="shadow-strong border-0 mb-4 overflow-hidden animate-fade-in cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => navigate('/gamification')}
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
                  <Award className="w-6 h-6 text-amber-600" />
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
        )}

        {/* Urgent Tools Alert */}
        {urgentTools.length > 0 && (
          <Card className="border-amber-200 bg-amber-50/50 mb-4 animate-fade-in" style={{ animationDelay: '0.05s' }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span className="font-semibold text-sm text-amber-800">
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
                        'text-xs font-medium',
                        days < 0 ? 'text-destructive' : 'text-amber-600'
                      )}>
                        {days < 0 ? `${Math.abs(days)}d atrasado` : days === 0 ? 'Hoje' : `Em ${days}d`}
                      </span>
                    </div>
                  );
                })}
              </div>
              <Button size="sm" className="w-full" onClick={() => navigate('/new-order')}>
                <PlusCircle className="w-4 h-4 mr-1" />
                Agendar afiação
              </Button>
            </CardContent>
          </Card>
        )}

        {/* CTA Novo Pedido */}
        <Card className="shadow-strong border-0 mb-4 overflow-hidden animate-fade-in" style={{ animationDelay: '0.1s' }}>
          <CardContent className="p-0">
            <button
              onClick={() => navigate('/new-order')}
              className="w-full p-5 flex items-center gap-4 group hover:bg-muted/30 transition-colors"
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-glow flex-shrink-0 group-hover:scale-105 transition-transform">
                <PlusCircle className="w-7 h-7 text-primary-foreground" />
              </div>
              <div className="flex-1 text-left">
                <h2 className="font-display font-bold text-lg text-foreground">Novo Pedido de Afiação</h2>
                <p className="text-sm text-muted-foreground">Agende a coleta das suas ferramentas</p>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:translate-x-1 group-hover:text-primary transition-all" />
            </button>
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <button onClick={() => navigate('/orders')} className="bg-card rounded-2xl p-3 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <ClipboardList className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <span className="text-xs font-medium text-foreground">Pedidos</span>
          </button>
          <button onClick={() => navigate('/tools')} className="bg-card rounded-2xl p-3 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <Wrench className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <span className="text-xs font-medium text-foreground">Ferramentas</span>
          </button>
          <button onClick={() => navigate('/recurring-schedules')} className="bg-card rounded-2xl p-3 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <CalendarClock className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <span className="text-xs font-medium text-foreground">Agendar</span>
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-6">
          <button onClick={() => navigate('/savings')} className="bg-card rounded-2xl p-3 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <PiggyBank className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <span className="text-xs font-medium text-foreground">Economia</span>
          </button>
          <button onClick={() => navigate('/training')} className="bg-card rounded-2xl p-3 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <BookOpen className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <span className="text-xs font-medium text-foreground">Treinar</span>
          </button>
          <button onClick={() => navigate('/gamification')} className="bg-card rounded-2xl p-3 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <Gamepad2 className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <span className="text-xs font-medium text-foreground">Ranking</span>
          </button>
        </div>

        {/* Pending Orders */}
        {pendingOrders.length > 0 && (
          <section className="mb-6 animate-fade-in" style={{ animationDelay: '0.15s' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-bold text-lg text-foreground">Em Andamento</h2>
              <button onClick={() => navigate('/orders')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
                Ver todos <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3">
              {pendingOrders.slice(0, 3).map((order, index) => {
                const config = statusConfig[order.status] || statusConfig['pedido_recebido'];
                return (
                  <Card key={order.id} className="overflow-hidden hover:shadow-medium transition-shadow cursor-pointer group animate-fade-in"
                    style={{ animationDelay: `${0.2 + index * 0.05}s` }}
                    onClick={() => navigate(`/orders/${order.id}`)}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                            <Package className="w-5 h-5 text-muted-foreground" />
                          </div>
                          <div>
                            <p className="font-semibold text-foreground">
                              {format(new Date(order.created_at), "dd 'de' MMM", { locale: ptBR })}
                            </p>
                            <p className="text-xs text-muted-foreground capitalize">{order.service_type}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn('text-xs px-2.5 py-1 rounded-full font-medium', config.bgColor, config.color)}>
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
          </section>
        )}

        {/* Tools preview with sharpening status */}
        {userTools.length > 0 && (
          <section className="mb-6 animate-fade-in" style={{ animationDelay: '0.25s' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-bold text-lg text-foreground">Minhas Ferramentas</h2>
              <button onClick={() => navigate('/tools')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
                Gerenciar <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {userTools.slice(0, 4).map((tool, index) => {
                const daysUntil = tool.next_sharpening_due 
                  ? differenceInDays(new Date(tool.next_sharpening_due), new Date()) : null;
                const needsSharpening = daysUntil !== null && daysUntil <= 7;
                return (
                  <Card key={tool.id} className={cn('animate-fade-in', needsSharpening && 'ring-1 ring-amber-300 bg-amber-50/50')}
                    style={{ animationDelay: `${0.3 + index * 0.05}s` }}>
                    <CardContent className="p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', needsSharpening ? 'bg-amber-100' : 'bg-muted')}>
                          <Wrench className={cn('w-4 h-4', needsSharpening ? 'text-amber-600' : 'text-muted-foreground')} />
                        </div>
                        <p className="font-medium text-sm text-foreground truncate flex-1">{tool.tool_categories?.name}</p>
                      </div>
                      {tool.next_sharpening_due && (
                        <p className={cn('text-xs flex items-center gap-1', needsSharpening ? 'text-amber-600 font-medium' : 'text-muted-foreground')}>
                          <Calendar className="w-3 h-3" />
                          {daysUntil !== null && daysUntil < 0 ? 'Atrasado' : daysUntil === 0 ? 'Hoje' : `Em ${daysUntil} dias`}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        {/* Empty state */}
        {pendingOrders.length === 0 && userTools.length === 0 && (
          <Card className="overflow-hidden animate-fade-in">
            <CardContent className="p-8 text-center">
              <div className="w-20 h-20 rounded-full bg-gradient-primary/10 mx-auto mb-4 flex items-center justify-center">
                <Sparkles className="w-10 h-10 text-primary" />
              </div>
              <h3 className="font-display font-bold text-xl text-foreground mb-2">Bem-vindo à Colacor!</h3>
              <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">
                Faça seu primeiro pedido de afiação e mantenha suas ferramentas sempre afiadas
              </p>
              <Button size="lg" onClick={() => navigate('/new-order')} className="shadow-glow">
                <PlusCircle className="w-5 h-5 mr-2" />
                Criar Primeiro Pedido
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Industrial benefit */}
        {profile?.customer_type === 'industrial' && (
          <section className="mt-6 animate-fade-in" style={{ animationDelay: '0.35s' }}>
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
          </section>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
