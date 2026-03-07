import { useState, useEffect } from 'react';
import { ArrowLeft, Star, Gift, Trophy, TrendingUp, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BottomNav } from '@/components/BottomNav';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface LoyaltyPoint {
  id: string;
  points: number;
  type: string;
  description: string | null;
  created_at: string;
  order_id: string | null;
}

const TIERS = [
  { name: 'Bronze', min: 0, icon: '🥉', color: 'text-amber-700' },
  { name: 'Prata', min: 200, icon: '🥈', color: 'text-slate-500' },
  { name: 'Ouro', min: 500, icon: '🥇', color: 'text-yellow-500' },
  { name: 'Diamante', min: 1000, icon: '💎', color: 'text-cyan-400' },
];

const REWARDS = [
  { name: '10% desconto no frete', points: 100, icon: '🚚' },
  { name: 'Afiação grátis (1 ferramenta)', points: 300, icon: '🔧' },
  { name: 'Kit de manutenção', points: 500, icon: '🧰' },
  { name: 'Desconto 20% no próximo pedido', points: 750, icon: '💰' },
];

export default function Loyalty() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [history, setHistory] = useState<LoyaltyPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    loadPoints();
  }, [user]);

  const loadPoints = async () => {
    try {
      const { data, error } = await supabase
        .from('loyalty_points')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setHistory(data || []);
    } catch (err) {
      console.error('Error loading loyalty points:', err);
    } finally {
      setLoading(false);
    }
  };

  const totalEarned = history.filter(h => h.type === 'earn').reduce((s, h) => s + h.points, 0);
  const totalRedeemed = history.filter(h => h.type === 'redeem').reduce((s, h) => s + Math.abs(h.points), 0);
  const balance = totalEarned - totalRedeemed;

  const currentTier = [...TIERS].reverse().find(t => balance >= t.min) || TIERS[0];
  const nextTier = TIERS.find(t => t.min > balance);
  const progressToNext = nextTier ? ((balance - currentTier.min) / (nextTier.min - currentTier.min)) * 100 : 100;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-8 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="max-w-lg mx-auto relative z-10">
          <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-secondary-foreground/70 mb-4">
            <ArrowLeft className="w-5 h-5" />
            <span className="text-sm">Voltar</span>
          </button>
          <div className="flex items-center gap-3 mb-4">
            <Trophy className="w-8 h-8 text-primary" />
            <div>
              <h1 className="text-2xl font-display font-bold">Programa de Fidelidade</h1>
              <p className="text-sm text-secondary-foreground/70">Acumule pontos e ganhe recompensas</p>
            </div>
          </div>

          {/* Points Card */}
          <Card className="bg-secondary-foreground/10 border-secondary-foreground/10 text-secondary-foreground">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs text-secondary-foreground/60 uppercase tracking-wider">Saldo de Pontos</p>
                  <p className="text-4xl font-bold">{balance}</p>
                </div>
                <div className="text-right">
                  <span className="text-3xl">{currentTier.icon}</span>
                  <p className={`text-sm font-semibold ${currentTier.color}`}>{currentTier.name}</p>
                </div>
              </div>
              {nextTier && (
                <div>
                  <div className="flex justify-between text-xs text-secondary-foreground/60 mb-1">
                    <span>{currentTier.name}</span>
                    <span>{nextTier.name} ({nextTier.min} pts)</span>
                  </div>
                  <div className="w-full bg-secondary-foreground/20 rounded-full h-2">
                    <div
                      className="bg-primary h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(progressToNext, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-secondary-foreground/50 mt-1">
                    Faltam {nextTier.min - balance} pontos para {nextTier.name}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </header>

      <main className="px-4 -mt-4 max-w-lg mx-auto space-y-6">
        {/* How it works */}
        <Card>
          <CardContent className="p-5">
            <h2 className="font-display font-bold text-lg text-foreground mb-3 flex items-center gap-2">
              <Star className="w-5 h-5 text-primary" />
              Como funciona
            </h2>
            <div className="space-y-3 text-sm text-muted-foreground">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary">1</span>
                </div>
                <p>A cada pedido entregue, você ganha pontos equivalentes ao valor do pedido (mínimo 10 pts)</p>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary">2</span>
                </div>
                <p>Acumule pontos para subir de nível e desbloquear recompensas exclusivas</p>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary">3</span>
                </div>
                <p>Troque seus pontos por descontos, serviços grátis e mais!</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Rewards */}
        <section>
          <h2 className="font-display font-bold text-lg text-foreground mb-3 flex items-center gap-2">
            <Gift className="w-5 h-5 text-primary" />
            Recompensas Disponíveis
          </h2>
          <div className="space-y-3">
            {REWARDS.map((reward) => {
              const canRedeem = balance >= reward.points;
              return (
                <Card key={reward.name} className={canRedeem ? 'ring-1 ring-primary/30' : 'opacity-70'}>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{reward.icon}</span>
                      <div>
                        <p className="font-medium text-foreground text-sm">{reward.name}</p>
                        <p className="text-xs text-muted-foreground">{reward.points} pontos</p>
                      </div>
                    </div>
                    <Button size="sm" variant={canRedeem ? 'default' : 'outline'} disabled={!canRedeem}>
                      {canRedeem ? 'Resgatar' : 'Bloqueado'}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        {/* History */}
        <section>
          <h2 className="font-display font-bold text-lg text-foreground mb-3 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" />
            Histórico
          </h2>
          {history.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center">
                <p className="text-sm text-muted-foreground">Nenhum ponto acumulado ainda. Faça seu primeiro pedido!</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {history.map(item => (
                <Card key={item.id}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">{item.description || 'Pontos'}</p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(item.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                      </p>
                    </div>
                    <Badge variant={item.type === 'earn' ? 'default' : 'destructive'}>
                      {item.type === 'earn' ? '+' : '-'}{Math.abs(item.points)} pts
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </main>

      <BottomNav />
    </div>
  );
}
