import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import {
  Loader2, Wrench, DollarSign, Calendar, TrendingUp,
  BarChart3, Clock, AlertTriangle, ShieldCheck, HelpCircle,
  ArrowRight, CheckCircle
} from 'lucide-react';
import { format, differenceInDays, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line
} from 'recharts';
import { cn } from '@/lib/utils';

/* ─── Types ─── */

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

/* ─── Criticality (shared with Tools/ToolHistory) ─── */

type Criticality = 'critical' | 'attention' | 'healthy' | 'unscheduled';

const CRIT_CONFIG: Record<Criticality, {
  label: string; icon: typeof AlertTriangle; badgeClass: string; bgClass: string;
}> = {
  critical: { label: 'Crítica', icon: AlertTriangle, badgeClass: 'border-destructive/40 bg-destructive/10 text-destructive', bgClass: 'bg-destructive/10' },
  attention: { label: 'Atenção', icon: Clock, badgeClass: 'border-status-warning/40 bg-status-warning-bg text-status-warning', bgClass: 'bg-status-warning-bg' },
  healthy: { label: 'Saudável', icon: ShieldCheck, badgeClass: 'border-emerald-400/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300', bgClass: 'bg-emerald-50 dark:bg-emerald-900/20' },
  unscheduled: { label: 'Não agendada', icon: HelpCircle, badgeClass: 'border-border bg-muted text-muted-foreground', bgClass: 'bg-muted' },
};

function getCriticality(nextDue: string | null): Criticality {
  if (!nextDue) return 'unscheduled';
  const days = differenceInDays(new Date(nextDue), new Date());
  if (days < 0) return 'critical';
  if (days <= 7) return 'attention';
  return 'healthy';
}

/* ─── Recommendation (shared logic with ToolHistory) ─── */

function computeRecommendation(
  criticality: Criticality,
  avgInterval: number | null,
  recommendedInterval: number | null,
  anomalyCount: number,
): { title: string; description: string; icon: typeof CheckCircle; color: string } {
  if (criticality === 'critical') {
    return { title: 'Afiação urgente', description: 'Ferramenta exige atenção imediata — agende a afiação o quanto antes.', icon: AlertTriangle, color: 'text-destructive' };
  }
  if (criticality === 'attention') {
    return { title: 'Afiar em breve', description: 'A próxima afiação está se aproximando — agende para evitar desgaste excessivo.', icon: Clock, color: 'text-status-warning' };
  }
  if (avgInterval && recommendedInterval && avgInterval < recommendedInterval * 0.7) {
    return { title: 'Uso intenso detectado', description: 'O intervalo real está abaixo do recomendado. Considere revisar a carga de trabalho ou o intervalo de afiação.', icon: TrendingUp, color: 'text-amber-600' };
  }
  if (anomalyCount >= 3) {
    return { title: 'Revisar condição geral', description: 'Múltiplas anomalias registradas. Avalie se a ferramenta precisa de reparo ou substituição.', icon: AlertTriangle, color: 'text-amber-600' };
  }
  return { title: 'Manter rotina atual', description: 'Ferramenta bem cuidada — continue seguindo o intervalo recomendado.', icon: CheckCircle, color: 'text-emerald-600 dark:text-emerald-400' };
}

/* ─── Stat Row component ─── */

function StatRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-medium', muted ? 'text-muted-foreground' : 'text-foreground')}>{value}</span>
    </div>
  );
}

/* ─── Main ─── */

const ToolReports = () => {
  const { toolId } = useParams<{ toolId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
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

  const analysis = useMemo(() => {
    if (!tool) return null;

    const sharpenings = events.filter(e => e.event_type === 'sharpening');
    const anomalies = events.filter(e => e.event_type === 'anomaly');
    const recommendedInterval = tool.sharpening_interval_days || tool.tool_categories?.suggested_interval_days || null;

    // Average interval between sharpenings
    let avgInterval: number | null = null;
    if (sharpenings.length > 1) {
      const totalDays = differenceInDays(
        new Date(sharpenings[sharpenings.length - 1].created_at),
        new Date(sharpenings[0].created_at),
      );
      avgInterval = Math.round(totalDays / (sharpenings.length - 1));
    }

    // Days since last sharpening
    const daysSinceLast = tool.last_sharpened_at
      ? differenceInDays(new Date(), new Date(tool.last_sharpened_at))
      : null;

    // Costs
    const totalCost = priceHistory.reduce((s, p) => s + p.unit_price, 0);
    const avgCost = priceHistory.length > 0 ? totalCost / priceHistory.length : null;

    // Criticality & recommendation
    const criticality = getCriticality(tool.next_sharpening_due);
    const recommendation = computeRecommendation(criticality, avgInterval, recommendedInterval, anomalies.length);

    // Charts
    const monthlyData: Record<string, number> = {};
    sharpenings.forEach(e => {
      const m = format(new Date(e.created_at), 'MMM/yy', { locale: ptBR });
      monthlyData[m] = (monthlyData[m] || 0) + 1;
    });
    const monthlyChart = Object.entries(monthlyData).map(([month, count]) => ({ month, count }));

    let cum = 0;
    const cumulativeChart = priceHistory.map(p => {
      cum += p.unit_price;
      return { date: format(new Date(p.created_at), 'dd/MM/yy'), total: cum };
    });

    return {
      sharpeningCount: sharpenings.length,
      anomalyCount: anomalies.length,
      avgInterval,
      daysSinceLast,
      recommendedInterval,
      totalCost,
      avgCost,
      criticality,
      recommendation,
      monthlyChart,
      cumulativeChart,
    };
  }, [tool, events, priceHistory]);

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

  if (!tool || !analysis) {
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
  const critCfg = CRIT_CONFIG[analysis.criticality];
  const CritIcon = critCfg.icon;
  const RecIcon = analysis.recommendation.icon;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Relatório" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-6">

        {/* ═══ HEADER ═══ */}
        <div className="pt-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Relatório da Ferramenta</p>
          <h1 className="font-display font-bold text-xl text-foreground mt-1">
            {tool.internal_code ? `${tool.internal_code} — ` : ''}{displayName}
          </h1>
          <div className="flex items-center gap-2 mt-2">
            <Badge className={cn('text-[10px] gap-1', critCfg.badgeClass)}>
              <CritIcon className="w-3 h-3" />
              {critCfg.label}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {tool.tool_categories?.name}
            </span>
          </div>
        </div>

        {/* ═══ 1. MANUTENÇÃO ═══ */}
        <section>
          <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Wrench className="w-4 h-4" />
            Manutenção
          </h2>
          <Card>
            <CardContent className="p-4 divide-y divide-border">
              <StatRow label="Serviços realizados" value={String(analysis.sharpeningCount)} />
              <StatRow
                label="Última afiação"
                value={tool.last_sharpened_at
                  ? format(new Date(tool.last_sharpened_at), "dd/MM/yyyy", { locale: ptBR })
                  : 'Sem registro'}
                muted={!tool.last_sharpened_at}
              />
              <StatRow
                label="Próxima recomendada"
                value={tool.next_sharpening_due
                  ? format(new Date(tool.next_sharpening_due), "dd/MM/yyyy", { locale: ptBR })
                  : 'Não agendada'}
                muted={!tool.next_sharpening_due}
              />
              <StatRow
                label="Intervalo médio"
                value={analysis.avgInterval ? `${analysis.avgInterval} dias` : 'Dados insuficientes'}
                muted={!analysis.avgInterval}
              />
              {analysis.recommendedInterval && (
                <StatRow label="Intervalo recomendado" value={`${analysis.recommendedInterval} dias`} />
              )}
              {analysis.daysSinceLast !== null && (
                <StatRow label="Desde a última afiação" value={`${analysis.daysSinceLast} dias`} />
              )}
            </CardContent>
          </Card>

          {/* Frequency chart */}
          {analysis.monthlyChart.length > 1 && (
            <Card className="mt-3">
              <CardContent className="p-4">
                <p className="text-xs font-medium text-muted-foreground mb-3">Frequência de afiações</p>
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.monthlyChart}>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Afiações" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}
        </section>

        {/* ═══ 2. CUSTOS ═══ */}
        <section>
          <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Custos
          </h2>
          {priceHistory.length > 0 ? (
            <>
              <Card>
                <CardContent className="p-4 divide-y divide-border">
                  <StatRow label="Custo acumulado" value={`R$ ${analysis.totalCost.toFixed(2)}`} />
                  {analysis.avgCost !== null && (
                    <StatRow label="Custo médio por afiação" value={`R$ ${analysis.avgCost.toFixed(2)}`} />
                  )}
                  <StatRow label="Afiações com custo" value={String(priceHistory.length)} />
                </CardContent>
              </Card>

              {analysis.cumulativeChart.length > 1 && (
                <Card className="mt-3">
                  <CardContent className="p-4">
                    <p className="text-xs font-medium text-muted-foreground mb-3">Custo acumulado (R$)</p>
                    <div className="h-40">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={analysis.cumulativeChart}>
                          <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                          <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip formatter={(v: number) => `R$ ${v.toFixed(2)}`} />
                          <Line type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="Total" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">
                  Ainda não há registros de custo. Os valores aparecerão conforme pedidos forem concluídos.
                </p>
              </CardContent>
            </Card>
          )}
        </section>

        {/* ═══ 3. RECOMENDAÇÃO ═══ */}
        <section>
          <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Recomendação
          </h2>
          <Card className="border-l-4" style={{ borderLeftColor: 'hsl(var(--primary))' }}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <RecIcon className={cn('w-5 h-5 mt-0.5 flex-shrink-0', analysis.recommendation.color)} />
                <div>
                  <p className="font-semibold text-foreground text-sm">{analysis.recommendation.title}</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {analysis.recommendation.description}
                  </p>
                </div>
              </div>
              <Button
                className="w-full mt-4 gap-2"
                onClick={() => navigate('/new-order')}
              >
                Agendar afiação
                <ArrowRight className="w-4 h-4" />
              </Button>
            </CardContent>
          </Card>
        </section>

        {/* Empty overlay when no events at all */}
        {events.length === 0 && priceHistory.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <BarChart3 className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="text-sm text-muted-foreground">
                Os dados completos serão preenchidos conforme pedidos forem concluídos.
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
