import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { 
  Trophy, Search, Target, Shield, Award, Star, 
  Heart, ChevronRight, Users, Loader2, Eye,
  BookOpen, Zap
} from 'lucide-react';

interface RankedUser {
  user_id: string;
  total_score: number;
  level: number;
  level_name: string;
  tool_health_index: number;
  consistency_score: number;
  organization_score: number;
  education_score: number;
  referral_score: number;
  efficiency_score: number;
  profile?: {
    name: string;
    document: string | null;
    customer_type: string | null;
  };
}

const LEVEL_ICONS: Record<number, typeof Trophy> = {
  1: Target,
  2: Shield,
  3: Award,
  4: Star,
  5: Trophy,
};

const LEVEL_COLORS: Record<number, string> = {
  1: 'text-muted-foreground bg-muted',
  2: 'text-blue-600 bg-blue-100',
  3: 'text-emerald-600 bg-emerald-100',
  4: 'text-amber-600 bg-amber-100',
  5: 'text-purple-600 bg-purple-100',
};

const AdminGamification = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading, role: userRole } = useAuth();
  const [users, setUsers] = useState<RankedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<RankedUser | null>(null);

  useEffect(() => {
    if (!authLoading && userRole !== null && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, userRole]);

  useEffect(() => {
    if (!isStaff) return;
    loadRanking();
  }, [isStaff]);

  const loadRanking = async () => {
    try {
      const { data: scores } = await supabase
        .from('gamification_scores')
        .select('*')
        .order('total_score', { ascending: false });

      if (!scores || scores.length === 0) {
        setUsers([]);
        setLoading(false);
        return;
      }

      const userIds = scores.map(s => s.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, document, customer_type')
        .in('user_id', userIds);

      const ranked = scores.map(s => ({
        ...s,
        profile: profiles?.find(p => p.user_id === s.user_id),
      })) as RankedUser[];

      setUsers(ranked);
    } catch (err) {
      console.error('Error loading ranking:', err);
    } finally {
      setLoading(false);
    }
  };

  const filtered = users.filter(u =>
    !search || u.profile?.name?.toLowerCase().includes(search.toLowerCase()) ||
    u.profile?.document?.includes(search)
  );

  // Stats
  const avgScore = users.length > 0 ? users.reduce((s, u) => s + u.total_score, 0) / users.length : 0;
  const avgHealth = users.length > 0 ? users.reduce((s, u) => s + u.tool_health_index, 0) / users.length : 0;
  const levelDistribution = [1, 2, 3, 4, 5].map(l => ({
    level: l,
    count: users.filter(u => u.level === l).length,
  }));

  if (authLoading || loading || userRole === null) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Ranking Gamificação" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Ranking Gamificação" showBack />

      <main className="pt-16 px-4 max-w-4xl mx-auto space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-foreground">{users.length}</p>
              <p className="text-xs text-muted-foreground">Participantes</p>
            </CardContent>
          </Card>
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-primary">{avgScore.toFixed(1)}</p>
              <p className="text-xs text-muted-foreground">Score Médio</p>
            </CardContent>
          </Card>
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-emerald-600">{avgHealth.toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground">Saúde Média</p>
            </CardContent>
          </Card>
        </div>

        {/* Level Distribution */}
        <Card>
          <CardContent className="p-4">
            <h3 className="font-semibold text-sm text-foreground mb-3">Distribuição por Nível</h3>
            <div className="flex gap-2">
              {levelDistribution.map(l => {
                const Icon = LEVEL_ICONS[l.level];
                const colorClasses = LEVEL_COLORS[l.level];
                return (
                  <div key={l.level} className="flex-1 text-center">
                    <div className={`w-8 h-8 rounded-lg mx-auto mb-1 flex items-center justify-center ${colorClasses}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <p className="text-lg font-bold text-foreground">{l.count}</p>
                    <p className="text-[10px] text-muted-foreground">Nível {l.level}</p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou documento..."
            className="pl-10"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Ranking List */}
        <div className="space-y-2">
          {filtered.map((user, index) => {
            const Icon = LEVEL_ICONS[user.level] || Target;
            const colorClasses = LEVEL_COLORS[user.level] || LEVEL_COLORS[1];
            const position = users.findIndex(u => u.user_id === user.user_id) + 1;

            return (
              <Card key={user.user_id} className="hover:shadow-medium transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    {/* Position */}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                      position <= 3 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'
                    }`}>
                      {position}
                    </div>

                    {/* Level Icon */}
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${colorClasses}`}>
                      <Icon className="w-5 h-5" />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground truncate">{user.profile?.name || 'Sem nome'}</p>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">{user.level_name}</Badge>
                        <span className="text-xs text-muted-foreground">
                          <Heart className="w-3 h-3 inline mr-0.5" />
                          {user.tool_health_index}%
                        </span>
                      </div>
                    </div>

                    {/* Score */}
                    <div className="text-right">
                      <p className="text-lg font-bold text-foreground">{user.total_score}</p>
                      <p className="text-[10px] text-muted-foreground">pontos</p>
                    </div>

                    {/* Detail button */}
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button size="icon" variant="ghost" onClick={() => setSelectedUser(user)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>{user.profile?.name || 'Cliente'}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div className="flex items-center gap-3">
                            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${colorClasses}`}>
                              <Icon className="w-6 h-6" />
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Nível {user.level}</p>
                              <p className="font-bold text-lg">{user.level_name}</p>
                            </div>
                            <div className="ml-auto text-right">
                              <p className="text-2xl font-bold text-primary">{user.total_score}</p>
                              <p className="text-xs text-muted-foreground">Score total</p>
                            </div>
                          </div>

                          {/* Pillar breakdown */}
                          {[
                            { label: 'Consistência (40%)', value: user.consistency_score, icon: Target },
                            { label: 'Organização (20%)', value: user.organization_score, icon: Shield },
                            { label: 'Educação (15%)', value: user.education_score, icon: BookOpen },
                            { label: 'Indicação (15%)', value: user.referral_score, icon: Users },
                            { label: 'Eficiência (10%)', value: user.efficiency_score, icon: Zap },
                          ].map(p => (
                            <div key={p.label}>
                              <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2">
                                  <p.icon className="w-4 h-4 text-muted-foreground" />
                                  <span className="text-sm">{p.label}</span>
                                </div>
                                <span className="font-bold text-sm">{p.value}</span>
                              </div>
                              <Progress value={p.value} className="h-1.5" />
                            </div>
                          ))}

                          <div className="pt-2 border-t border-border">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Heart className="w-4 h-4 text-emerald-600" />
                                <span className="text-sm font-medium">Saúde das Ferramentas</span>
                              </div>
                              <span className="text-lg font-bold text-emerald-600">{user.tool_health_index}%</span>
                            </div>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {filtered.length === 0 && (
            <Card className="text-center py-8">
              <CardContent>
                <Trophy className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
                <p className="font-semibold text-foreground">Nenhum participante encontrado</p>
                <p className="text-sm text-muted-foreground">Os scores são calculados quando clientes acessam o sistema</p>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminGamification;
