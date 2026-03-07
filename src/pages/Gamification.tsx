import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GamificationCertificate } from '@/components/GamificationCertificate';
import { useGamificationScore, getLevelInfo } from '@/hooks/useGamificationScore';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { 
  Trophy, Shield, Target, BookOpen, Users, Zap, 
  Heart, ChevronRight, Star, Award, TrendingUp,
  Loader2, Lock, Lightbulb, ArrowRight
} from 'lucide-react';

const LEVEL_CONFIG = [
  { level: 1, name: 'Operacional', icon: Target, color: 'text-muted-foreground', bg: 'bg-muted' },
  { level: 2, name: 'Organizado', icon: Shield, color: 'text-blue-600', bg: 'bg-blue-100' },
  { level: 3, name: 'Profissional', icon: Award, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  { level: 4, name: 'Elite Técnica', icon: Star, color: 'text-amber-600', bg: 'bg-amber-100' },
  { level: 5, name: 'Parceiro Estratégico', icon: Trophy, color: 'text-purple-600', bg: 'bg-purple-100' },
];

const PILLAR_CONFIG = [
  { key: 'consistency_score', label: 'Consistência', icon: Target, weight: '40%', description: 'Ferramentas mantidas dentro da janela ideal' },
  { key: 'organization_score', label: 'Organização', icon: Shield, weight: '20%', description: 'Qualidade de envio das ferramentas' },
  { key: 'education_score', label: 'Educação', icon: BookOpen, weight: '15%', description: 'Treinamentos técnicos concluídos' },
  { key: 'referral_score', label: 'Indicação', icon: Users, weight: '15%', description: 'Indicações convertidas' },
  { key: 'efficiency_score', label: 'Eficiência', icon: Zap, weight: '10%', description: 'Gestão preventiva vs emergencial' },
];

const BENEFITS = [
  { level: 2, benefits: ['Relatório técnico simplificado'] },
  { level: 3, benefits: ['Prioridade na fila', 'Coleta diferenciada'] },
  { level: 4, benefits: ['Diagnóstico preventivo gratuito', 'Condições comerciais diferenciadas'] },
  { level: 5, benefits: ['Acesso antecipado a novos serviços', 'Grupo técnico exclusivo', 'Certificação profissional'] },
];

const PILLAR_ACTIONS: Record<string, { tip: string; cta: string; route: string }> = {
  consistency_score: {
    tip: 'Mantenha suas ferramentas dentro da janela ideal de afiação. Cadastre todas e acompanhe os prazos.',
    cta: 'Ver ferramentas',
    route: '/tools',
  },
  organization_score: {
    tip: 'Melhore a qualidade de envio: ferramentas limpas, identificadas, separadas por tipo e bem embaladas.',
    cta: 'Novo pedido',
    route: '/orders/new',
  },
  education_score: {
    tip: 'Complete treinamentos técnicos disponíveis para ganhar pontos nesse pilar.',
    cta: 'Ver treinamentos',
    route: '/training',
  },
  referral_score: {
    tip: 'Indique outros profissionais. Quando sua indicação se torna cliente ativo, você ganha pontos.',
    cta: 'Indicar cliente',
    route: '/support',
  },
  efficiency_score: {
    tip: 'Reduza pedidos emergenciais. Planeje manutenções preventivas para melhorar esse pilar.',
    cta: 'Ver ferramentas',
    route: '/tools',
  },
};

const Gamification = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: score, loading } = useGamificationScore();
  const [rankPosition, setRankPosition] = useState<number | null>(null);
  const [totalUsers, setTotalUsers] = useState(0);

  useEffect(() => {
    if (!user) return;
    const loadRank = async () => {
      // Get user's position: count users with higher score
      const { count: above } = await supabase
        .from('gamification_scores')
        .select('id', { count: 'exact', head: true })
        .gt('total_score', score?.total_score || 0);
      
      const { count: total } = await supabase
        .from('gamification_scores')
        .select('id', { count: 'exact', head: true });

      setRankPosition((above || 0) + 1);
      setTotalUsers(total || 0);
    };
    if (score) loadRank();
  }, [user, score]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Gamificação" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  const levelInfo = score ? getLevelInfo(score.total_score) : getLevelInfo(0);
  const currentLevelConfig = LEVEL_CONFIG.find(l => l.level === (score?.level || 1)) || LEVEL_CONFIG[0];
  const LevelIcon = currentLevelConfig.icon;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meu Desempenho" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
        {/* Level Card */}
        <Card className="overflow-hidden border-0 shadow-strong">
          <div className="bg-gradient-dark text-secondary-foreground p-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-40 h-40 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div className="relative z-10">
              <div className="flex items-center gap-4 mb-4">
                <div className={`w-16 h-16 rounded-2xl ${currentLevelConfig.bg} flex items-center justify-center`}>
                  <LevelIcon className={`w-8 h-8 ${currentLevelConfig.color}`} />
                </div>
                <div>
                  <p className="text-sm text-secondary-foreground/60">Nível {score?.level || 1}</p>
                  <h2 className="text-2xl font-display font-bold">{score?.level_name || 'Operacional'}</h2>
                </div>
              </div>

              <div className="mb-2">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-secondary-foreground/70">Pontuação total</span>
                  <span className="font-bold">{score?.total_score || 0}/100</span>
                </div>
                <Progress value={score?.total_score || 0} className="h-3 bg-secondary-foreground/10" />
              </div>

              {levelInfo.nextLevel && (
                <p className="text-xs text-secondary-foreground/50">
                  Faltam {Math.ceil(levelInfo.nextLevel.min - (score?.total_score || 0))} pontos para "{levelInfo.nextLevel.name}"
                </p>
              )}
            </div>
          </div>

          {/* Rank position (anonymous) */}
          {rankPosition && (
            <CardContent className="p-4 border-t border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium text-foreground">Sua posição no ranking</span>
                </div>
                <Badge variant="secondary" className="text-sm font-bold">
                  #{rankPosition} de {totalUsers}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                <Lock className="w-3 h-3 inline mr-1" />
                Rankings individuais são privados
              </p>
            </CardContent>
          )}
        </Card>

        {/* Tool Health Index */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
                <Heart className="w-5 h-5 text-emerald-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-foreground">Índice de Saúde das Ferramentas</h3>
                <p className="text-xs text-muted-foreground">% dentro da janela ideal de manutenção</p>
              </div>
              <span className="text-2xl font-bold text-emerald-600">{score?.tool_health_index || 0}%</span>
            </div>
            <Progress value={score?.tool_health_index || 0} className="h-2" />
          </CardContent>
        </Card>

        {/* Next Best Action */}
        {score && (() => {
          const pillars = PILLAR_CONFIG.map(p => ({
            ...p,
            value: (score as any)[p.key] as number,
          }));
          const weakest = pillars.reduce((min, p) => p.value < min.value ? p : min, pillars[0]);
          const action = PILLAR_ACTIONS[weakest.key];
          const WeakIcon = weakest.icon;

          return (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Lightbulb className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground text-sm mb-1">Como subir de nível mais rápido</h3>
                    <div className="flex items-center gap-1.5 mb-2">
                      <WeakIcon className="w-3.5 h-3.5 text-primary" />
                      <span className="text-xs font-medium text-primary">{weakest.label} — {weakest.value}/100</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{action.tip}</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="w-full mt-3"
                  onClick={() => navigate(action.route)}
                >
                  {action.cta}
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </CardContent>
            </Card>
          );
        })()}

        {/* Score Pillars */}
        <div>
          <h3 className="font-display font-bold text-lg text-foreground mb-3">Pilares de Pontuação</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Fórmula: (Consistência×40%) + (Organização×20%) + (Educação×15%) + (Indicação×15%) + (Eficiência×10%)
          </p>

          <div className="space-y-3">
            {PILLAR_CONFIG.map(pillar => {
              const value = score ? (score as any)[pillar.key] : 0;
              const Icon = pillar.icon;
              return (
                <Card key={pillar.key}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3 mb-2">
                      <Icon className="w-5 h-5 text-primary" />
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-foreground text-sm">{pillar.label}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs">{pillar.weight}</Badge>
                            <span className="font-bold text-sm">{value}</span>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">{pillar.description}</p>
                      </div>
                    </div>
                    <Progress value={value} className="h-1.5" />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Levels Journey */}
        <div>
          <h3 className="font-display font-bold text-lg text-foreground mb-3">Jornada de Níveis</h3>
          <div className="space-y-2">
            {LEVEL_CONFIG.map((lvl, idx) => {
              const isActive = (score?.level || 1) >= lvl.level;
              const isCurrent = (score?.level || 1) === lvl.level;
              const Icon = lvl.icon;
              const benefits = BENEFITS.find(b => b.level === lvl.level);

              return (
                <Card key={lvl.level} className={isCurrent ? 'ring-2 ring-primary' : isActive ? '' : 'opacity-50'}>
                  <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl ${isActive ? lvl.bg : 'bg-muted'} flex items-center justify-center`}>
                        <Icon className={`w-5 h-5 ${isActive ? lvl.color : 'text-muted-foreground'}`} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-foreground">{lvl.name}</span>
                          {isCurrent && <Badge className="text-[10px] px-1.5 py-0">Atual</Badge>}
                          {!isActive && <Lock className="w-3 h-3 text-muted-foreground" />}
                        </div>
                        {benefits && (
                          <p className="text-xs text-muted-foreground">
                            {benefits.benefits.join(' • ')}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Certificate */}
        {score && score.level >= 3 && (
          <GamificationCertificate
            userName={user?.email?.split('@')[0] || 'Cliente'}
            levelName={score.level_name}
            level={score.level}
            totalScore={score.total_score}
          />
        )}

        {/* Quick Actions */}
        <div className="grid grid-cols-3 gap-3">
          <Button variant="outline" className="h-auto py-3 flex-col gap-1" onClick={() => navigate('/tools')}>
            <Target className="w-5 h-5" />
            <span className="text-xs">Ferramentas</span>
          </Button>
          <Button variant="outline" className="h-auto py-3 flex-col gap-1" onClick={() => navigate('/training')}>
            <BookOpen className="w-5 h-5" />
            <span className="text-xs">Treinamentos</span>
          </Button>
          <Button variant="outline" className="h-auto py-3 flex-col gap-1" onClick={() => navigate('/loyalty')}>
            <Trophy className="w-5 h-5" />
            <span className="text-xs">Fidelidade</span>
          </Button>
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default Gamification;
