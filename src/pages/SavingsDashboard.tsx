import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, TrendingUp, DollarSign, Wrench, Leaf, PiggyBank } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, LineChart, Line } from 'recharts';
import { format, subMonths, startOfMonth, endOfMonth } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// Estimated average cost of buying a new tool (no real data available)
const AVG_NEW_TOOL_COST = 250; // R$ estimated

interface MonthlyData {
  month: string;
  sharpeningCost: number;
  newToolCost: number;
  savings: number;
  toolCount: number;
}

const SavingsDashboard = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [totalTools, setTotalTools] = useState(0);
  const [totalSpent, setTotalSpent] = useState(0);

  useEffect(() => {
    if (user) loadData();
  }, [user]);

  const loadData = async () => {
    if (!user) return;

    try {
      // Get completed orders for last 12 months
      const twelveMonthsAgo = subMonths(new Date(), 12);
      const { data: orders, error } = await supabase
        .from('orders')
        .select('id, items, total, created_at, status')
        .eq('user_id', user.id)
        .eq('status', 'entregue')
        .gte('created_at', twelveMonthsAgo.toISOString())
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Group by month
      const monthMap = new Map<string, { total: number; toolCount: number }>();
      let allToolsCount = 0;
      let allSpent = 0;

      (orders || []).forEach(order => {
        const monthKey = format(new Date(order.created_at), 'yyyy-MM');
        const items = Array.isArray(order.items) ? order.items : [];
        const toolCount = items.reduce((sum: number, item: any) => sum + (item.quantity || 1), 0);
        
        const existing = monthMap.get(monthKey) || { total: 0, toolCount: 0 };
        monthMap.set(monthKey, {
          total: existing.total + (order.total || 0),
          toolCount: existing.toolCount + toolCount,
        });

        allToolsCount += toolCount;
        allSpent += order.total || 0;
      });

      // Generate last 6 months data
      const data: MonthlyData[] = [];
      for (let i = 5; i >= 0; i--) {
        const date = subMonths(new Date(), i);
        const key = format(date, 'yyyy-MM');
        const monthData = monthMap.get(key) || { total: 0, toolCount: 0 };
        const newToolCost = monthData.toolCount * AVG_NEW_TOOL_COST;
        const savings = newToolCost - monthData.total;

        data.push({
          month: format(date, 'MMM', { locale: ptBR }),
          sharpeningCost: monthData.total,
          newToolCost: newToolCost,
          savings: savings > 0 ? savings : 0,
          toolCount: monthData.toolCount,
        });
      }

      setMonthlyData(data);
      setTotalOrders(orders?.length || 0);
      setTotalTools(allToolsCount);
      setTotalSpent(allSpent);
    } catch (error) {
      console.error('Error loading savings data:', error);
    } finally {
      setLoading(false);
    }
  };

  const totalSavings = totalTools * AVG_NEW_TOOL_COST - totalSpent;
  const savingsPercent = totalTools > 0 ? Math.round(((totalTools * AVG_NEW_TOOL_COST - totalSpent) / (totalTools * AVG_NEW_TOOL_COST)) * 100) : 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Economia" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Sua Economia" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Hero savings card */}
        <Card className="mb-4 bg-gradient-to-br from-emerald-500 to-emerald-700 text-white border-0">
          <CardContent className="p-6 text-center">
            <PiggyBank className="w-10 h-10 mx-auto mb-2 opacity-80" />
            <p className="text-sm opacity-80">Economia total estimada</p>
            <p className="text-4xl font-bold mt-1">
              R$ {totalSavings > 0 ? totalSavings.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '0'}
            </p>
            {savingsPercent > 0 && (
              <p className="text-sm mt-2 opacity-90">
                Você economizou ~{savingsPercent}% em relação a comprar ferramentas novas
              </p>
            )}
            <p className="text-xs mt-2 opacity-60">
              * Estimativa baseada no custo médio de reposição de ferramentas novas (R$ {AVG_NEW_TOOL_COST}). Valores de afiação são reais dos seus pedidos.
            </p>
          </CardContent>
        </Card>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card>
            <CardContent className="p-3 text-center">
              <DollarSign className="w-5 h-5 text-primary mx-auto mb-1" />
              <p className="text-lg font-bold">R$ {totalSpent.toFixed(0)}</p>
              <p className="text-xs text-muted-foreground">Investido</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <Wrench className="w-5 h-5 text-primary mx-auto mb-1" />
              <p className="text-lg font-bold">{totalTools}</p>
              <p className="text-xs text-muted-foreground">Afiações</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <Leaf className="w-5 h-5 text-emerald-500 mx-auto mb-1" />
              <p className="text-lg font-bold">{totalTools}</p>
              <p className="text-xs text-muted-foreground">Ferramentas salvas</p>
            </CardContent>
          </Card>
        </div>

        {/* Comparison chart */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Afiação vs Comprar Nova
            </CardTitle>
            <p className="text-xs text-muted-foreground">Últimos 6 meses</p>
          </CardHeader>
          <CardContent>
            {monthlyData.some(d => d.toolCount > 0) ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={monthlyData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={v => `R$${v}`} />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `R$ ${value.toFixed(2)}`,
                      name === 'sharpeningCost' ? 'Afiação' : 'Ferramenta nova',
                    ]}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  />
                  <Bar dataKey="sharpeningCost" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="sharpeningCost" />
                  <Bar dataKey="newToolCost" fill="hsl(var(--muted-foreground) / 0.3)" radius={[4, 4, 0, 0]} name="newToolCost" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">Sem dados suficientes ainda</p>
                <p className="text-xs text-muted-foreground/70">Os gráficos aparecerão quando você tiver pedidos concluídos</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Savings over time */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <PiggyBank className="w-4 h-4" />
              Economia Acumulada
            </CardTitle>
          </CardHeader>
          <CardContent>
            {monthlyData.some(d => d.savings > 0) ? (
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={v => `R$${v}`} />
                  <Tooltip
                    formatter={(value: number) => [`R$ ${value.toFixed(2)}`, 'Economia']}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  />
                  <Line type="monotone" dataKey="savings" stroke="#10b981" strokeWidth={2} dot={{ fill: '#10b981' }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">Dados serão exibidos com pedidos concluídos</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Eco impact */}
        <Card className="bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
          <CardContent className="p-4 flex gap-3">
            <Leaf className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">Impacto Ambiental</p>
              <p className="text-xs text-emerald-700 dark:text-emerald-300">
                Ao afiar {totalTools} ferramenta{totalTools !== 1 ? 's' : ''} ao invés de descartá-la{totalTools !== 1 ? 's' : ''}, 
                você evitou {(totalTools * 0.5).toFixed(1)} kg de resíduos metálicos.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>

      <BottomNav />
    </div>
  );
};

export default SavingsDashboard;
