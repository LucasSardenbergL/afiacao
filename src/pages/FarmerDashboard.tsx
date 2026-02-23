import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFarmerMetrics } from '@/hooks/useFarmerMetrics';
import { useAuth } from '@/contexts/AuthContext';
import {
  Phone, TrendingUp, Users, Clock, Target, BarChart3,
  ArrowUp, ArrowDown, Minus, Brain, RefreshCw, ChevronRight,
  Zap, PieChart, Activity
} from 'lucide-react';
import { Loader2 } from 'lucide-react';

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m${sec > 0 ? ` ${sec}s` : ''}`;
};

const formatCurrency = (val: number) =>
  val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FarmerDashboard = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { metrics, loading, adjustWeights } = useFarmerMetrics();
  const [adjusting, setAdjusting] = useState(false);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isStaff) {
    navigate('/', { replace: true });
    return null;
  }

  const handleAdjustWeights = async () => {
    setAdjusting(true);
    await adjustWeights();
    setAdjusting(false);
  };

  const recommendationConfig = {
    expand: { label: 'Expandir Carteira', color: 'bg-emerald-100 text-emerald-800', icon: ArrowUp },
    reduce: { label: 'Reduzir Carteira', color: 'bg-red-100 text-red-800', icon: ArrowDown },
    maintain: { label: 'Manter Carteira', color: 'bg-blue-100 text-blue-800', icon: Minus },
  };

  const rec = recommendationConfig[metrics.portfolioRecommendation];
  const RecIcon = rec.icon;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Farmer – Gestão de Carteira" />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {/* Quick Actions */}
        <div className="grid grid-cols-2 gap-3">
          <Button
            className="h-auto py-4 flex flex-col items-center gap-2"
            onClick={() => navigate('/farmer/calls')}
          >
            <Phone className="w-5 h-5" />
            <span className="text-xs">Registrar Ligação</span>
          </Button>
          <Button
            variant="outline"
            className="h-auto py-4 flex flex-col items-center gap-2"
            onClick={() => navigate('/farmer/calls')}
          >
            <BarChart3 className="w-5 h-5" />
            <span className="text-xs">Histórico</span>
          </Button>
        </div>

        {/* Recommendation Card */}
        <Card className="border-2 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-full ${rec.color}`}>
                  <RecIcon className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Recomendação</p>
                  <p className="font-semibold text-sm">{rec.label}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Dados</p>
                <p className="text-sm font-medium">{metrics.daysOfData} dias</p>
              </div>
            </div>
            {!metrics.hasEnoughData && (
              <p className="text-xs text-muted-foreground mt-2 bg-muted/50 rounded p-2">
                ⚡ O sistema precisa de pelo menos 30 dias de dados para recomendações precisas. Continue registrando ligações!
              </p>
            )}
          </CardContent>
        </Card>

        <Tabs defaultValue="capacity" className="w-full">
          <TabsList className="w-full grid grid-cols-3">
            <TabsTrigger value="capacity" className="text-xs">
              <Zap className="w-3 h-3 mr-1" />
              Capacidade
            </TabsTrigger>
            <TabsTrigger value="financial" className="text-xs">
              <TrendingUp className="w-3 h-3 mr-1" />
              Financeiro
            </TabsTrigger>
            <TabsTrigger value="learning" className="text-xs">
              <Brain className="w-3 h-3 mr-1" />
              Aprendizado
            </TabsTrigger>
          </TabsList>

          {/* CAPACITY TAB */}
          <TabsContent value="capacity" className="space-y-3 mt-3">
            <div className="grid grid-cols-2 gap-3">
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Target className="w-4 h-4 text-primary" />
                    <span className="text-xs text-muted-foreground">Capacidade/Dia</span>
                  </div>
                  <p className="text-2xl font-bold">{Math.round(metrics.capacityPerDay)}</p>
                  <p className="text-xs text-muted-foreground">ligações</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="w-4 h-4 text-primary" />
                    <span className="text-xs text-muted-foreground">Carteira Ideal</span>
                  </div>
                  <p className="text-2xl font-bold">{metrics.optimalClientsCount}</p>
                  <p className="text-xs text-muted-foreground">clientes</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm">Métricas Operacionais</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-3">
                <MetricRow
                  label="Tempo Médio de Ligação (T_call)"
                  value={formatDuration(metrics.avgCallDuration)}
                />
                <MetricRow
                  label="Tempo Médio de Follow-up (T_follow)"
                  value={formatDuration(metrics.avgFollowUpDuration)}
                />
                <MetricRow
                  label="Tentativas até Contato (N_attempts)"
                  value={metrics.avgAttemptsToContact.toFixed(1)}
                />
                <MetricRow
                  label="T_total por contato"
                  value={metrics.tTotal > 0 ? `${(metrics.tTotal * 60).toFixed(0)} min` : '-'}
                />
                <MetricRow
                  label="Taxa de Contato"
                  value={`${metrics.contactRate.toFixed(1)}%`}
                />
                <MetricRow
                  label="Total de Ligações"
                  value={String(metrics.totalCalls)}
                />
                <MetricRow
                  label="Clientes Ativos"
                  value={String(metrics.currentActiveClients)}
                />
                <MetricRow
                  label="Horas Úteis/Dia"
                  value={`${metrics.avgDailyHours.toFixed(1)}h`}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* FINANCIAL TAB */}
          <TabsContent value="financial" className="space-y-3 mt-3">
            <div className="grid grid-cols-2 gap-3">
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                    <span className="text-xs text-muted-foreground">Margem/Hora</span>
                  </div>
                  <p className="text-xl font-bold text-emerald-700">
                    {formatCurrency(metrics.marginPerHour)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Activity className="w-4 h-4 text-blue-600" />
                    <span className="text-xs text-muted-foreground">Receita/Ligação</span>
                  </div>
                  <p className="text-xl font-bold text-blue-700">
                    {formatCurrency(metrics.revenuePerCall)}
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm">Totais do Período ({metrics.daysOfData} dias)</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-3">
                <MetricRow
                  label="Receita Incremental Total"
                  value={formatCurrency(metrics.totalRevenue)}
                />
                <MetricRow
                  label="Margem Incremental Total"
                  value={formatCurrency(metrics.totalMargin)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <PieChart className="w-4 h-4" />
                  Conversão por Tipo
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-3">
                <ConversionBar label="Reativação" value={metrics.conversionByType.reativacao} />
                <ConversionBar label="Cross-sell" value={metrics.conversionByType.cross_sell} />
                <ConversionBar label="Up-sell" value={metrics.conversionByType.up_sell} />
                <ConversionBar label="Follow-up" value={metrics.conversionByType.follow_up} />
              </CardContent>
            </Card>
          </TabsContent>

          {/* LEARNING TAB */}
          <TabsContent value="learning" className="space-y-3 mt-3">
            <Card className={!metrics.hasEnoughData ? 'opacity-60' : ''}>
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Brain className="w-4 h-4" />
                    Aprendizado Automático
                  </CardTitle>
                  {metrics.hasEnoughData && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleAdjustWeights}
                      disabled={adjusting}
                      className="h-7 text-xs"
                    >
                      {adjusting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                      Recalcular
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-4">
                {!metrics.hasEnoughData && (
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground">
                      🧠 O sistema precisa de <strong>30 dias</strong> de dados para ajustar automaticamente os pesos.
                      Você tem <strong>{metrics.daysOfData} dias</strong> registrados.
                    </p>
                    <Progress value={(metrics.daysOfData / 30) * 100} className="mt-2 h-2" />
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium mb-2">Distribuição de Agenda Sugerida</p>
                  <div className="space-y-2">
                    <AgendaBar label="Risco/Reativação" value={metrics.weights.agenda_pct_risk * 100} color="bg-red-500" />
                    <AgendaBar label="Recuperação/Follow-up" value={metrics.weights.agenda_pct_recovery * 100} color="bg-amber-500" />
                    <AgendaBar label="Expansão (Cross/Up-sell)" value={metrics.weights.agenda_pct_expansion * 100} color="bg-emerald-500" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground">Ligações/Dia Sugeridas</p>
                    <p className="text-lg font-bold">
                      {metrics.weights.suggested_calls_per_day ?? Math.round(metrics.capacityPerDay)}
                    </p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground">Carteira Sugerida</p>
                    <p className="text-lg font-bold">
                      {metrics.weights.suggested_portfolio_size ?? metrics.optimalClientsCount}
                    </p>
                  </div>
                </div>

                {metrics.weights.last_adjusted_at && (
                  <p className="text-xs text-muted-foreground text-center">
                    Último ajuste: {new Date(metrics.weights.last_adjusted_at).toLocaleDateString('pt-BR')}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm">Pesos do Priority Score</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <WeightRow label="Recência" value={metrics.weights.weight_recency} />
                <WeightRow label="Frequência" value={metrics.weights.weight_frequency} />
                <WeightRow label="Monetário" value={metrics.weights.weight_monetary} />
                <WeightRow label="Margem" value={metrics.weights.weight_margin} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <BottomNav />
    </div>
  );
};

const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className="text-sm font-semibold">{value}</span>
  </div>
);

const ConversionBar = ({ label, value }: { label: string; value: number }) => (
  <div>
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs">{label}</span>
      <span className="text-xs font-semibold">{value.toFixed(1)}%</span>
    </div>
    <Progress value={value} className="h-2" />
  </div>
);

const AgendaBar = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div>
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs">{label}</span>
      <span className="text-xs font-semibold">{value.toFixed(0)}%</span>
    </div>
    <div className="w-full bg-muted rounded-full h-2">
      <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${value}%` }} />
    </div>
  </div>
);

const WeightRow = ({ label, value }: { label: string; value: number }) => (
  <div className="flex items-center justify-between">
    <span className="text-xs">{label}</span>
    <div className="flex items-center gap-2">
      <div className="w-20 bg-muted rounded-full h-2">
        <div className="bg-primary h-2 rounded-full" style={{ width: `${value * 100}%` }} />
      </div>
      <span className="text-xs font-semibold w-10 text-right">{(value * 100).toFixed(0)}%</span>
    </div>
  </div>
);

export default FarmerDashboard;
