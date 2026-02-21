import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, BarChart3, Clock, Wrench, Star, TrendingUp, CheckCircle2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell } from 'recharts';
import { format, subDays, startOfDay, endOfDay, differenceInHours } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface DailyStats {
  date: string;
  completed: number;
}

const CHART_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--muted-foreground))',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
];

const AdminProductivity = () => {
  const { user, isStaff } = useAuth();
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('7');

  // Stats
  const [totalCompleted, setTotalCompleted] = useState(0);
  const [avgTimeHours, setAvgTimeHours] = useState(0);
  const [avgRating, setAvgRating] = useState(0);
  const [totalReviews, setTotalReviews] = useState(0);
  const [dailyData, setDailyData] = useState<DailyStats[]>([]);
  const [statusDistribution, setStatusDistribution] = useState<{ name: string; value: number }[]>([]);

  useEffect(() => {
    if (isStaff) loadData();
  }, [isStaff, period]);

  const loadData = async () => {
    setLoading(true);
    try {
      const days = parseInt(period);
      const startDate = subDays(new Date(), days);

      // Get completed orders in period
      const { data: completedOrders } = await supabase
        .from('orders')
        .select('id, created_at, updated_at, status')
        .eq('status', 'entregue')
        .gte('updated_at', startDate.toISOString());

      // Get all orders for status distribution
      const { data: allOrders } = await supabase
        .from('orders')
        .select('status')
        .gte('created_at', startDate.toISOString());

      // Get reviews
      const { data: reviews } = await (supabase as any)
        .from('order_reviews')
        .select('rating')
        .gte('created_at', startDate.toISOString());

      // Calculate stats
      const completed = completedOrders || [];
      setTotalCompleted(completed.length);

      // Avg turnaround time
      if (completed.length > 0) {
        const totalHours = completed.reduce((sum, order) => {
          return sum + differenceInHours(new Date(order.updated_at), new Date(order.created_at));
        }, 0);
        setAvgTimeHours(Math.round(totalHours / completed.length));
      }

      // Reviews
      const reviewList = (reviews || []) as { rating: number }[];
      setTotalReviews(reviewList.length);
      if (reviewList.length > 0) {
        const totalRating = reviewList.reduce((sum, r) => sum + r.rating, 0);
        setAvgRating(totalRating / reviewList.length);
      }

      // Daily completion chart
      const dailyMap = new Map<string, number>();
      for (let i = days - 1; i >= 0; i--) {
        const d = format(subDays(new Date(), i), 'yyyy-MM-dd');
        dailyMap.set(d, 0);
      }
      completed.forEach(order => {
        const d = format(new Date(order.updated_at), 'yyyy-MM-dd');
        dailyMap.set(d, (dailyMap.get(d) || 0) + 1);
      });
      const daily: DailyStats[] = [];
      dailyMap.forEach((count, date) => {
        daily.push({ date: format(new Date(date), 'dd/MM'), completed: count });
      });
      setDailyData(daily);

      // Status distribution
      const statusMap = new Map<string, number>();
      const STATUS_LABELS: Record<string, string> = {
        pedido_recebido: 'Recebido',
        aguardando_coleta: 'Aguardando',
        em_triagem: 'Triagem',
        em_rota: 'Em Rota',
        entregue: 'Entregue',
      };
      (allOrders || []).forEach(o => {
        const label = STATUS_LABELS[o.status] || o.status;
        statusMap.set(label, (statusMap.get(label) || 0) + 1);
      });
      setStatusDistribution(Array.from(statusMap.entries()).map(([name, value]) => ({ name, value })));

    } catch (error) {
      console.error('Error loading productivity data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Produtividade" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Produtividade" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Period selector */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-bold text-lg">Visão Geral</h2>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 dias</SelectItem>
              <SelectItem value="14">14 dias</SelectItem>
              <SelectItem value="30">30 dias</SelectItem>
              <SelectItem value="90">90 dias</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <Card>
            <CardContent className="p-4 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto mb-1" />
              <p className="text-2xl font-bold">{totalCompleted}</p>
              <p className="text-xs text-muted-foreground">Pedidos concluídos</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Clock className="w-6 h-6 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold">{avgTimeHours}h</p>
              <p className="text-xs text-muted-foreground">Tempo médio</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Star className="w-6 h-6 text-amber-400 mx-auto mb-1" />
              <p className="text-2xl font-bold">{avgRating > 0 ? avgRating.toFixed(1) : '—'}</p>
              <p className="text-xs text-muted-foreground">{totalReviews} avaliações</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <TrendingUp className="w-6 h-6 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold">
                {totalCompleted > 0 ? (totalCompleted / parseInt(period)).toFixed(1) : '0'}
              </p>
              <p className="text-xs text-muted-foreground">Média/dia</p>
            </CardContent>
          </Card>
        </div>

        {/* Daily completions chart */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              Pedidos Concluídos por Dia
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                  <Tooltip
                    formatter={(value: number) => [value, 'Concluídos']}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  />
                  <Bar dataKey="completed" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">Sem dados no período</p>
            )}
          </CardContent>
        </Card>

        {/* Status distribution */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench className="w-4 h-4" />
              Distribuição por Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statusDistribution.length > 0 ? (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="50%" height={160}>
                  <PieChart>
                    <Pie
                      data={statusDistribution}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={60}
                      innerRadius={30}
                    >
                      {statusDistribution.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5">
                  {statusDistribution.map((item, i) => (
                    <div key={item.name} className="flex items-center gap-2 text-xs">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                      <span className="text-muted-foreground flex-1">{item.name}</span>
                      <span className="font-medium">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">Sem dados no período</p>
            )}
          </CardContent>
        </Card>
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminProductivity;
