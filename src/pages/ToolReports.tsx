import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, Wrench, DollarSign, Calendar, TrendingUp, BarChart3, Clock } from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';

interface ToolData {
  id: string;
  internal_code: string | null;
  custom_name: string | null;
  generated_name: string | null;
  created_at: string;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  sharpening_interval_days: number | null;
  tool_categories: {
    name: string;
    suggested_interval_days: number | null;
  };
}

interface ToolEvent {
  id: string;
  event_type: string;
  created_at: string;
  metadata: Record<string, any> | null;
  order_id: string | null;
}

interface PriceRecord {
  unit_price: number;
  created_at: string;
}

const CHART_COLORS = ['hsl(var(--primary))', 'hsl(var(--destructive))', 'hsl(142, 76%, 36%)', 'hsl(38, 92%, 50%)'];

const ToolReports = () => {
  const { toolId } = useParams<{ toolId: string }>();
  const { user } = useAuth();
  const [tool, setTool] = useState<ToolData | null>(null);
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [priceHistory, setPriceHistory] = useState<PriceRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (toolId && user) loadData();
  }, [toolId, user]);

  const loadData = async () => {
    try {
      const [toolRes, eventsRes, priceRes] = await Promise.all([
        supabase.from('user_tools').select('*, tool_categories(*)').eq('id', toolId!).single(),
        supabase.from('tool_events').select('*').eq('user_tool_id', toolId!).order('created_at', { ascending: true }),
        supabase.from('order_price_history').select('unit_price, created_at').eq('user_tool_id', toolId!).order('created_at', { ascending: true }),
      ]);

      if (toolRes.data) setTool(toolRes.data as unknown as ToolData);
      if (eventsRes.data) setEvents(eventsRes.data as ToolEvent[]);
      if (priceRes.data) setPriceHistory(priceRes.data as PriceRecord[]);
    } catch (error) {
      console.error('Error loading tool reports:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Relatório" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!tool) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Relatório" showBack />
        <div className="text-center py-20">
          <Wrench className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">Ferramenta não encontrada</p>
        </div>
        <BottomNav />
      </div>
    );
  }

  const displayName = tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';
  const sharpeningEvents = events.filter(e => e.event_type === 'sharpening');
  const anomalyEvents = events.filter(e => e.event_type === 'anomaly');
  
  // Age in days
  const ageDays = differenceInDays(new Date(), new Date(tool.created_at));
  const avgInterval = sharpeningEvents.length > 1
    ? Math.round(ageDays / sharpeningEvents.length)
    : tool.sharpening_interval_days || tool.tool_categories?.suggested_interval_days || 90;

  // Estimated total cost
  const totalCost = priceHistory.reduce((sum, p) => sum + p.unit_price, 0);

  // Sharpening frequency by month
  const monthlyData: Record<string, number> = {};
  sharpeningEvents.forEach(e => {
    const month = format(new Date(e.created_at), 'MMM/yy', { locale: ptBR });
    monthlyData[month] = (monthlyData[month] || 0) + 1;
  });
  const monthlyChartData = Object.entries(monthlyData).map(([month, count]) => ({ month, count }));

  // Cost over time
  const costData = priceHistory.map(p => ({
    date: format(new Date(p.created_at), 'dd/MM/yy'),
    cost: p.unit_price,
  }));

  // Cumulative cost
  let cumCost = 0;
  const cumulativeCostData = priceHistory.map(p => {
    cumCost += p.unit_price;
    return {
      date: format(new Date(p.created_at), 'dd/MM/yy'),
      total: cumCost,
    };
  });

  // Event type breakdown
  const eventTypeBreakdown = [
    { name: 'Afiações', value: sharpeningEvents.length },
    { name: 'Anomalias', value: anomalyEvents.length },
    { name: 'Inspeções', value: events.filter(e => e.event_type === 'inspection').length },
    { name: 'Outros', value: events.filter(e => !['sharpening', 'anomaly', 'inspection'].includes(e.event_type)).length },
  ].filter(d => d.value > 0);

  // Estimated remaining life (rough estimate based on anomalies)
  const estimatedLifeMonths = anomalyEvents.length > 2
    ? Math.max(3, 24 - anomalyEvents.length * 3)
    : ageDays < 365 ? 24 : 12;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title={`Relatório — ${tool.internal_code || displayName}`} showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardContent className="p-4 text-center">
              <BarChart3 className="w-5 h-5 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold text-foreground">{sharpeningEvents.length}</p>
              <p className="text-xs text-muted-foreground">Afiações</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <DollarSign className="w-5 h-5 text-emerald-600 mx-auto mb-1" />
              <p className="text-2xl font-bold text-foreground">
                R$ {totalCost.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">Custo total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Calendar className="w-5 h-5 text-amber-600 mx-auto mb-1" />
              <p className="text-2xl font-bold text-foreground">{avgInterval}d</p>
              <p className="text-xs text-muted-foreground">Intervalo médio</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Clock className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
              <p className="text-2xl font-bold text-foreground">{Math.round(ageDays / 30)}m</p>
              <p className="text-xs text-muted-foreground">Idade</p>
            </CardContent>
          </Card>
        </div>

        {/* Health estimate */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-foreground">Vida útil estimada</h3>
                <p className="text-xs text-muted-foreground">
                  ~{estimatedLifeMonths} meses restantes (estimativa baseada no histórico)
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Sharpening frequency chart */}
        {monthlyChartData.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Frequência de Afiações por Mês</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Afiações" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cumulative cost chart */}
        {cumulativeCostData.length > 1 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Custo Acumulado (R$)</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={cumulativeCostData}>
                    <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: number) => `R$ ${v.toFixed(2)}`} />
                    <Line type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="Total" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Event type breakdown */}
        {eventTypeBreakdown.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Tipos de Eventos</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="h-48 flex items-center justify-center">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={eventTypeBreakdown} cx="50%" cy="50%" outerRadius={70} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                      {eventTypeBreakdown.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {events.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <BarChart3 className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="text-sm text-muted-foreground">
                Ainda não há dados suficientes para gerar relatórios.
                Os gráficos serão preenchidos conforme pedidos forem concluídos.
              </p>
            </CardContent>
          </Card>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default ToolReports;
