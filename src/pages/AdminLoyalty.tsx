import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Trophy, Search, Plus, Minus, Gift, Users, TrendingUp, DollarSign, BarChart3, Crown } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CustomerPoints {
  user_id: string;
  name: string;
  total_earned: number;
  total_redeemed: number;
  balance: number;
}

interface PointRecord {
  id: string;
  user_id: string;
  points: number;
  type: string;
  description: string | null;
  created_at: string;
  order_id: string | null;
}

interface RedemptionRecord {
  id: string;
  user_id: string;
  reward_name: string;
  points_spent: number;
  status: string;
  created_at: string;
}

const TIERS = [
  { name: 'Bronze', min: 0, icon: '🥉' },
  { name: 'Prata', min: 200, icon: '🥈' },
  { name: 'Ouro', min: 500, icon: '🥇' },
  { name: 'Diamante', min: 1000, icon: '💎' },
];

function getTier(balance: number) {
  return [...TIERS].reverse().find(t => balance >= t.min) || TIERS[0];
}

export default function AdminLoyalty() {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [customers, setCustomers] = useState<CustomerPoints[]>([]);
  const [allPoints, setAllPoints] = useState<PointRecord[]>([]);
  const [redemptions, setRedemptions] = useState<RedemptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerPoints | null>(null);
  const [customerHistory, setCustomerHistory] = useState<PointRecord[]>([]);

  // Adjust points dialog
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustUserId, setAdjustUserId] = useState('');
  const [adjustType, setAdjustType] = useState<'earn' | 'redeem'>('earn');
  const [adjustPoints, setAdjustPoints] = useState('');
  const [adjustDescription, setAdjustDescription] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      loadData();
    }
  }, [user, isStaff]);

  const loadData = async () => {
    try {
      const [pointsRes, profilesRes, redemptionsRes] = await Promise.all([
        (supabase as any).from('loyalty_points').select('*').order('created_at', { ascending: false }),
        supabase.from('profiles').select('user_id, name'),
        supabase.from('loyalty_redemptions').select('*').order('created_at', { ascending: false }),
      ]);

      const points = (pointsRes.data || []) as PointRecord[];
      const profiles = profilesRes.data || [];
      const redData = (redemptionsRes.data || []) as RedemptionRecord[];
      setAllPoints(points);
      setRedemptions(redData);

      // Aggregate by user
      const userMap = new Map<string, CustomerPoints>();
      for (const p of points) {
        if (!userMap.has(p.user_id)) {
          const profile = profiles.find(pr => pr.user_id === p.user_id);
          userMap.set(p.user_id, {
            user_id: p.user_id,
            name: profile?.name || 'Desconhecido',
            total_earned: 0,
            total_redeemed: 0,
            balance: 0,
          });
        }
        const c = userMap.get(p.user_id)!;
        if (p.type === 'earn') {
          c.total_earned += p.points;
        } else {
          c.total_redeemed += Math.abs(p.points);
        }
        c.balance = c.total_earned - c.total_redeemed;
      }

      setCustomers(Array.from(userMap.values()).sort((a, b) => b.balance - a.balance));
    } catch (err) {
      console.error('Error loading loyalty data:', err);
    } finally {
      setLoading(false);
    }
  };

  const viewCustomerHistory = (customer: CustomerPoints) => {
    setSelectedCustomer(customer);
    setCustomerHistory(allPoints.filter(p => p.user_id === customer.user_id));
  };

  const handleAdjustPoints = async () => {
    if (!adjustPoints || !adjustUserId) return;
    setAdjusting(true);

    try {
      const pts = parseInt(adjustPoints);
      if (isNaN(pts) || pts <= 0) {
        toast({ title: 'Pontos inválidos', variant: 'destructive' });
        return;
      }

      const { error } = await (supabase as any).from('loyalty_points').insert({
        user_id: adjustUserId,
        points: adjustType === 'redeem' ? -pts : pts,
        type: adjustType,
        description: adjustDescription || (adjustType === 'earn' ? 'Pontos adicionados pelo admin' : 'Resgate aprovado pelo admin'),
      });

      if (error) throw error;

      toast({ title: adjustType === 'earn' ? 'Pontos adicionados!' : 'Resgate aprovado!' });
      setAdjustOpen(false);
      setAdjustPoints('');
      setAdjustDescription('');
      loadData();
    } catch (err) {
      console.error('Error adjusting points:', err);
      toast({ title: 'Erro ao ajustar pontos', variant: 'destructive' });
    } finally {
      setAdjusting(false);
    }
  };

  const totalPointsCirculating = customers.reduce((s, c) => s + c.balance, 0);
  const totalEarned = customers.reduce((s, c) => s + c.total_earned, 0);
  const totalRedeemed = customers.reduce((s, c) => s + c.total_redeemed, 0);

  // Estimated liability: 1 pt ≈ R$0.01 (conservative estimate based on typical reward catalog)
  const estimatedLiability = totalPointsCirculating * 0.01;
  const redemptionRate = totalEarned > 0 ? ((totalRedeemed / totalEarned) * 100).toFixed(1) : '0';

  // Top redeemed rewards
  const rewardCounts = new Map<string, number>();
  for (const r of redemptions) {
    rewardCounts.set(r.reward_name, (rewardCounts.get(r.reward_name) || 0) + 1);
  }
  const topRewards = Array.from(rewardCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Top balance users (already sorted)
  const topBalanceUsers = customers.slice(0, 5);

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Fidelidade - Admin" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  // Detail view
  if (selectedCustomer) {
    const tier = getTier(selectedCustomer.balance);
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title={selectedCustomer.name} showBack />
        <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs text-muted-foreground uppercase">Saldo</p>
                  <p className="text-3xl font-bold text-foreground">{selectedCustomer.balance} pts</p>
                </div>
                <div className="text-center">
                  <span className="text-3xl">{tier.icon}</span>
                  <p className="text-xs font-medium text-muted-foreground">{tier.name}</p>
                </div>
              </div>
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>Ganhos: <strong className="text-foreground">{selectedCustomer.total_earned}</strong></span>
                <span>Resgatados: <strong className="text-foreground">{selectedCustomer.total_redeemed}</strong></span>
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => {
                setAdjustUserId(selectedCustomer.user_id);
                setAdjustType('earn');
                setAdjustOpen(true);
              }}
            >
              <Plus className="w-4 h-4 mr-1" /> Adicionar Pontos
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setAdjustUserId(selectedCustomer.user_id);
                setAdjustType('redeem');
                setAdjustOpen(true);
              }}
            >
              <Minus className="w-4 h-4 mr-1" /> Resgatar
            </Button>
          </div>

          <h3 className="font-display font-bold text-foreground">Histórico</h3>
          <div className="space-y-2">
            {customerHistory.map(item => (
              <Card key={item.id}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">{item.description || 'Pontos'}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(item.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                    </p>
                  </div>
                  <Badge variant={item.type === 'earn' ? 'default' : 'destructive'}>
                    {item.type === 'earn' ? '+' : ''}{item.points} pts
                  </Badge>
                </CardContent>
              </Card>
            ))}
            {customerHistory.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">Sem histórico</p>
            )}
          </div>

          <Button variant="ghost" className="w-full" onClick={() => setSelectedCustomer(null)}>
            ← Voltar à lista
          </Button>
        </main>
        <BottomNav />

        {/* Adjust Dialog */}
        <AdjustDialog
          open={adjustOpen}
          onOpenChange={setAdjustOpen}
          type={adjustType}
          points={adjustPoints}
          setPoints={setAdjustPoints}
          description={adjustDescription}
          setDescription={setAdjustDescription}
          onSubmit={handleAdjustPoints}
          loading={adjusting}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Fidelidade - Admin" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <TrendingUp className="w-5 h-5 mx-auto text-primary mb-1" />
              <p className="text-xl font-bold text-foreground">{totalPointsCirculating}</p>
              <p className="text-[10px] text-muted-foreground">Em circulação</p>
            </CardContent>
          </Card>
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <Plus className="w-5 h-5 mx-auto text-emerald-500 mb-1" />
              <p className="text-xl font-bold text-foreground">{totalEarned}</p>
              <p className="text-[10px] text-muted-foreground">Total ganhos</p>
            </CardContent>
          </Card>
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <Gift className="w-5 h-5 mx-auto text-amber-500 mb-1" />
              <p className="text-xl font-bold text-foreground">{totalRedeemed}</p>
              <p className="text-[10px] text-muted-foreground">Resgatados</p>
            </CardContent>
          </Card>
        </div>

        {/* Economic insights */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Visão Econômica</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Passivo estimado</p>
                <p className="text-lg font-bold text-foreground">
                  R$ {estimatedLiability.toFixed(2)}
                </p>
                <p className="text-[10px] text-muted-foreground">se todos resgatassem</p>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Taxa de resgate</p>
                <p className="text-lg font-bold text-foreground">{redemptionRate}%</p>
                <p className="text-[10px] text-muted-foreground">resgatados / emitidos</p>
              </div>
            </div>

            {topRewards.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <BarChart3 className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-xs font-medium text-muted-foreground">Recompensas mais resgatadas</p>
                </div>
                <div className="space-y-1">
                  {topRewards.map(([name, count]) => (
                    <div key={name} className="flex items-center justify-between text-sm">
                      <span className="text-foreground truncate">{name}</span>
                      <Badge variant="secondary" className="text-xs">{count}x</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {topBalanceUsers.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Crown className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-xs font-medium text-muted-foreground">Maiores saldos</p>
                </div>
                <div className="space-y-1">
                  {topBalanceUsers.map(u => (
                    <div key={u.user_id} className="flex items-center justify-between text-sm">
                      <span className="text-foreground truncate">{u.name}</span>
                      <span className="font-medium text-foreground">{u.balance} pts</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>


        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar cliente..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Customer list */}
        <div className="space-y-2">
          {filtered.length === 0 && (
            <Card>
              <CardContent className="p-6 text-center">
                <Users className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">
                  {search ? 'Nenhum cliente encontrado' : 'Nenhum cliente com pontos ainda'}
                </p>
              </CardContent>
            </Card>
          )}
          {filtered.map(customer => {
            const tier = getTier(customer.balance);
            return (
              <Card
                key={customer.user_id}
                className="cursor-pointer hover:shadow-medium transition-shadow"
                onClick={() => viewCustomerHistory(customer)}
              >
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{tier.icon}</span>
                    <div>
                      <p className="font-semibold text-foreground">{customer.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {tier.name} · {customer.balance} pontos
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={e => {
                        e.stopPropagation();
                        setAdjustUserId(customer.user_id);
                        setAdjustType('earn');
                        setAdjustOpen(true);
                      }}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={e => {
                        e.stopPropagation();
                        setAdjustUserId(customer.user_id);
                        setAdjustType('redeem');
                        setAdjustOpen(true);
                      }}
                    >
                      <Gift className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </main>

      <BottomNav />

      {/* Adjust Dialog */}
      <AdjustDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        type={adjustType}
        points={adjustPoints}
        setPoints={setAdjustPoints}
        description={adjustDescription}
        setDescription={setAdjustDescription}
        onSubmit={handleAdjustPoints}
        loading={adjusting}
      />
    </div>
  );
}

function AdjustDialog({
  open, onOpenChange, type, points, setPoints, description, setDescription, onSubmit, loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  type: 'earn' | 'redeem';
  points: string;
  setPoints: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {type === 'earn' ? '➕ Adicionar Pontos' : '🎁 Aprovar Resgate'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground">Pontos</label>
            <Input
              type="number"
              min="1"
              value={points}
              onChange={e => setPoints(e.target.value)}
              placeholder="Ex: 100"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Descrição</label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={type === 'earn' ? 'Motivo do bônus...' : 'Recompensa resgatada...'}
              rows={2}
            />
          </div>
          <Button onClick={onSubmit} disabled={loading || !points} className="w-full">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {type === 'earn' ? 'Adicionar Pontos' : 'Aprovar Resgate'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
