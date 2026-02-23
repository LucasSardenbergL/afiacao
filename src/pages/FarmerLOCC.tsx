import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useFarmerMetrics } from '@/hooks/useFarmerMetrics';
import { useFarmerExperiments, type Experiment } from '@/hooks/useFarmerExperiments';
import { useFarmerGovernance } from '@/hooks/useFarmerGovernance';
import { useCrossSellEngine } from '@/hooks/useCrossSellEngine';
import { useAuth } from '@/contexts/AuthContext';
import {
  Loader2, Heart, Users, Target, Brain, Shield, FlaskConical, Activity,
  TrendingUp, Phone, RefreshCw, Plus, Play, BarChart3, Package,
  CheckCircle, XCircle, Clock, Zap, DollarSign, ChevronRight, Radio
} from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────────────
const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDur = (s: number) => {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60) > 0 ? ` ${Math.round(s % 60)}s` : ''}`;
};

const healthColors: Record<string, { bg: string; text: string }> = {
  saudavel: { bg: 'bg-emerald-50', text: 'text-emerald-700' },
  estavel: { bg: 'bg-blue-50', text: 'text-blue-700' },
  atencao: { bg: 'bg-amber-50', text: 'text-amber-700' },
  critico: { bg: 'bg-red-50', text: 'text-red-700' },
};

const metricLabels: Record<string, string> = {
  margem_por_hora: 'Margem/Hora',
  ltv: 'LTV',
  churn: 'Churn (%)',
  receita_incremental: 'Receita Incremental',
};

const statusColors: Record<string, string> = {
  rascunho: 'bg-muted text-muted-foreground',
  ativo: 'bg-blue-100 text-blue-800',
  concluido: 'bg-emerald-100 text-emerald-800',
  cancelado: 'bg-red-100 text-red-800',
};

const FarmerLOCC = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const { clientScores, summary, loading: scoringLoading, calculating: scoringCalc, recalculate, config } = useFarmerScoring();
  const { metrics, loading: metricsLoading } = useFarmerMetrics();
  const { experiments, loading: expLoading, createExperiment, startExperiment, measureExperiment, cancelExperiment } = useFarmerExperiments();
  const { proposals, isGovernor, loading: govLoading } = useFarmerGovernance();
  const { recommendations, calculating: recCalc, calculateRecommendations } = useCrossSellEngine();

  const loading = authLoading || scoringLoading || metricsLoading;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  const pendingProposals = proposals.filter(p => p.status === 'aguardando_aprovacao').length;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="LOCC" showBack />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {/* Header Card */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <FlaskConical className="w-5 h-5 text-primary" />
              <h2 className="text-sm font-bold">Laboratório de Otimização Comercial Contínuo</h2>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Sistema adaptativo: testa, mede e otimiza margem incremental por hora, LTV e churn.
            </p>
          </CardContent>
        </Card>

        {/* Quick Navigation */}
        <div className="grid grid-cols-5 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Heart className="w-4 h-4" />
            <span className="text-[9px]">Diagnóstico</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/calls')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Phone className="w-4 h-4" />
            <span className="text-[9px]">Ligações</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/recommendations')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Zap className="w-4 h-4" />
            <span className="text-[9px]">Cross/Up</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/bundles')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Package className="w-4 h-4" />
            <span className="text-[9px]">Bundles</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/copilot')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Radio className="w-4 h-4" />
            <span className="text-[9px]">Copiloto</span>
          </Button>
        </div>

        <div className="grid grid-cols-1">
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/governance')} className="h-auto py-2 flex flex-row items-center gap-2 relative">
            <Shield className="w-4 h-4" />
            <span className="text-[9px]">Governança</span>
            {pendingProposals > 0 && (
              <span className="bg-destructive text-destructive-foreground text-[8px] rounded-full w-4 h-4 flex items-center justify-center">
                {pendingProposals}
              </span>
            )}
          </Button>
        </div>

        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="overview" className="text-[10px] px-1">Visão Geral</TabsTrigger>
            <TabsTrigger value="experiments" className="text-[10px] px-1">Experimentos</TabsTrigger>
            <TabsTrigger value="capacity" className="text-[10px] px-1">Capacidade</TabsTrigger>
            <TabsTrigger value="adaptive" className="text-[10px] px-1">Otimização</TabsTrigger>
          </TabsList>

          {/* ─── OVERVIEW TAB ──────────────────────────────────────── */}
          <TabsContent value="overview" className="space-y-3 mt-3">
            {/* Health Summary */}
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Heart className="w-4 h-4 text-primary" />
                    <span className="text-xs font-semibold">Motor de Diagnóstico</span>
                  </div>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={recalculate} disabled={scoringCalc}>
                    {scoringCalc ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  </Button>
                </div>
                <div className="grid grid-cols-4 gap-1 text-center">
                  {(['saudavel', 'estavel', 'atencao', 'critico'] as const).map(cls => {
                    const count = summary[cls];
                    const hc = healthColors[cls];
                    return (
                      <div key={cls} className={`rounded-lg p-1.5 ${hc.bg}`}>
                        <p className={`text-lg font-bold ${hc.text}`}>{count}</p>
                        <p className="text-[9px] text-muted-foreground capitalize">{cls === 'saudavel' ? 'Saudável' : cls === 'estavel' ? 'Estável' : cls === 'atencao' ? 'Atenção' : 'Crítico'}</p>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between text-xs mt-2">
                  <span className="text-muted-foreground">Health Score Médio</span>
                  <span className="font-bold">{summary.avgHealth}</span>
                </div>
                <Progress value={summary.avgHealth} className="h-1.5 mt-1" />
              </CardContent>
            </Card>

            {/* KPIs */}
            <div className="grid grid-cols-3 gap-2">
              <Card>
                <CardContent className="p-2.5 text-center">
                  <p className="text-lg font-bold">{fmt(metrics.marginPerHour)}</p>
                  <p className="text-[9px] text-muted-foreground">Margem/Hora</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-2.5 text-center">
                  <p className="text-lg font-bold">{Math.round(metrics.capacityPerDay)}</p>
                  <p className="text-[9px] text-muted-foreground">Cap./Dia</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-2.5 text-center">
                  <p className="text-lg font-bold">{summary.totalClients}</p>
                  <p className="text-[9px] text-muted-foreground">Clientes</p>
                </CardContent>
              </Card>
            </div>

            {/* Quick Cross-sell summary */}
            <Card className="cursor-pointer" onClick={() => navigate('/farmer/recommendations')}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-600" />
                    <span className="text-xs font-semibold">Recomendações LIE</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-bold text-emerald-700">
                      {recommendations.reduce((s, r) => s + [...r.crossSell, ...r.upSell].reduce((s2, rec) => s2 + rec.lie, 0), 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                    </span>
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Active experiments summary */}
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FlaskConical className="w-4 h-4 text-blue-600" />
                    <span className="text-xs font-semibold">Experimentos</span>
                  </div>
                  <div className="flex gap-1">
                    <Badge variant="outline" className="text-[9px]">{experiments.filter(e => e.status === 'ativo').length} ativos</Badge>
                    <Badge variant="outline" className="text-[9px]">{experiments.filter(e => e.status === 'concluido').length} concluídos</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── EXPERIMENTS TAB ─────────────────────────────────── */}
          <TabsContent value="experiments" className="space-y-3 mt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Motor Experimental</span>
              <NewExperimentDialog onCreate={createExperiment} />
            </div>

            {experiments.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center">
                  <FlaskConical className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-xs text-muted-foreground">Nenhum experimento criado. Crie seu primeiro teste A/B.</p>
                </CardContent>
              </Card>
            ) : (
              experiments.map(exp => (
                <ExperimentCard
                  key={exp.id}
                  experiment={exp}
                  onStart={startExperiment}
                  onMeasure={measureExperiment}
                  onCancel={cancelExperiment}
                />
              ))
            )}
          </TabsContent>

          {/* ─── CAPACITY TAB ────────────────────────────────────── */}
          <TabsContent value="capacity" className="space-y-3 mt-3">
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Motor de Capacidade
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <MetricRow label="T_call médio" value={fmtDur(metrics.avgCallDuration)} />
                <MetricRow label="T_follow médio" value={fmtDur(metrics.avgFollowUpDuration)} />
                <MetricRow label="N_attempts médio" value={metrics.avgAttemptsToContact.toFixed(1)} />
                <MetricRow label="T_total por contato" value={metrics.tTotal > 0 ? `${(metrics.tTotal * 60).toFixed(0)} min` : '-'} />
                <MetricRow label="Capacidade/Dia" value={`${Math.round(metrics.capacityPerDay)} ligações`} />
                <MetricRow label="Carteira Ideal" value={`${metrics.optimalClientsCount} clientes`} />
                <MetricRow label="Margem Incremental/Ligação" value={metrics.totalCalls > 0 ? fmt(metrics.totalMargin / metrics.totalCalls) : '-'} />
                <MetricRow label="Margem/Hora" value={fmt(metrics.marginPerHour)} />
                <MetricRow label="Taxa de Contato" value={`${metrics.contactRate.toFixed(1)}%`} />
                <MetricRow label="Total de Ligações" value={String(metrics.totalCalls)} />
                <MetricRow label="Dias de dados" value={`${metrics.daysOfData}`} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" /> Conversão por Tipo
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <MetricRow label="Reativação" value={`${metrics.conversionByType.reativacao.toFixed(1)}%`} />
                <MetricRow label="Cross-sell" value={`${metrics.conversionByType.cross_sell.toFixed(1)}%`} />
                <MetricRow label="Up-sell" value={`${metrics.conversionByType.up_sell.toFixed(1)}%`} />
                <MetricRow label="Follow-up" value={`${metrics.conversionByType.follow_up.toFixed(1)}%`} />
              </CardContent>
            </Card>

            {!metrics.hasEnoughData && (
              <Card className="border-dashed">
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground">
                    ⚡ Após <strong>30 dias</strong> de dados o sistema ajustará automaticamente.
                    Progresso: {metrics.daysOfData}/30 dias.
                  </p>
                  <Progress value={(metrics.daysOfData / 30) * 100} className="h-2 mt-2" />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ─── ADAPTIVE TAB ────────────────────────────────────── */}
          <TabsContent value="adaptive" className="space-y-3 mt-3">
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Brain className="w-4 h-4" /> Otimização Adaptativa
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-3">
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Pesos do Health Score</p>
                  <WeightBar label="RF (Recência)" value={config.health_w_rf * 100} />
                  <WeightBar label="M (Monetário)" value={config.health_w_m * 100} />
                  <WeightBar label="G (Margem)" value={config.health_w_g * 100} />
                  <WeightBar label="X (Mix)" value={config.health_w_x * 100} />
                  <WeightBar label="S (Atendimento)" value={config.health_w_s * 100} />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Pesos do Priority Score</p>
                  <WeightBar label="Churn Risk" value={config.priority_w_churn * 100} />
                  <WeightBar label="Recover" value={config.priority_w_recover * 100} />
                  <WeightBar label="Expansion" value={config.priority_w_expansion * 100} />
                  <WeightBar label="Efficiency" value={config.priority_w_eff * 100} />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Quotas da Agenda</p>
                  <WeightBar label="Risco/Recuperação" value={config.agenda_pct_risco * 100} color="bg-destructive" />
                  <WeightBar label="Expansão" value={config.agenda_pct_expansao * 100} color="bg-emerald-500" />
                  <WeightBar label="Follow-up" value={config.agenda_pct_followup * 100} color="bg-blue-500" />
                </div>
              </CardContent>
            </Card>

            {/* Portfolio Recommendation */}
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-primary" />
                  <span className="text-xs font-semibold">Recomendação de Carteira</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={
                    metrics.portfolioRecommendation === 'expand' ? 'bg-emerald-100 text-emerald-800' :
                    metrics.portfolioRecommendation === 'reduce' ? 'bg-red-100 text-red-800' :
                    'bg-blue-100 text-blue-800'
                  }>
                    {metrics.portfolioRecommendation === 'expand' ? '📈 Expandir' :
                     metrics.portfolioRecommendation === 'reduce' ? '📉 Reduzir' :
                     '➡️ Manter'}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    Atual: {metrics.currentActiveClients} · Ideal: {metrics.optimalClientsCount}
                  </span>
                </div>
                {metrics.weights.suggested_calls_per_day && (
                  <p className="text-[10px] text-muted-foreground mt-2">
                    💡 Ligações sugeridas/dia: <strong>{metrics.weights.suggested_calls_per_day}</strong> · 
                    Portfólio sugerido: <strong>{metrics.weights.suggested_portfolio_size}</strong>
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Frequency suggestion */}
            <Card>
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="w-4 h-4 text-primary" />
                  <span className="text-xs font-semibold">Frequência Ótima de Contato</span>
                </div>
                <p className="text-sm font-bold">{metrics.optimalFrequencyPerMonth.toFixed(1)}x/mês</p>
                <p className="text-[10px] text-muted-foreground">
                  Baseado em {metrics.daysOfData} dias de dados e {metrics.totalCalls} ligações
                </p>
              </CardContent>
            </Card>

            <Button variant="outline" className="w-full" onClick={() => navigate('/farmer/governance')}>
              <Shield className="w-4 h-4 mr-2" /> Propor Alteração de Pesos
            </Button>
          </TabsContent>
        </Tabs>
      </main>
      <BottomNav />
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────────────
const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className="text-xs font-semibold">{value}</span>
  </div>
);

const WeightBar = ({ label, value, color = 'bg-primary' }: { label: string; value: number; color?: string }) => (
  <div className="mb-1">
    <div className="flex items-center justify-between">
      <span className="text-[10px]">{label}</span>
      <span className="text-[10px] font-semibold">{value.toFixed(0)}%</span>
    </div>
    <div className="w-full bg-muted rounded-full h-1.5">
      <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${value}%` }} />
    </div>
  </div>
);

const ExperimentCard = ({ experiment, onStart, onMeasure, onCancel }: {
  experiment: Experiment;
  onStart: (id: string) => void;
  onMeasure: (id: string) => void;
  onCancel: (id: string) => void;
}) => {
  const sc = statusColors[experiment.status] || statusColors.rascunho;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate">{experiment.title}</p>
            <p className="text-[10px] text-muted-foreground truncate">{experiment.hypothesis}</p>
          </div>
          <Badge className={`text-[9px] ${sc}`}>{experiment.status}</Badge>
        </div>

        <div className="grid grid-cols-3 gap-1 text-center mb-2">
          <div className="bg-muted/50 rounded p-1">
            <p className="text-[9px] text-muted-foreground">Métrica</p>
            <p className="text-[10px] font-semibold">{metricLabels[experiment.primary_metric]}</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="text-[9px] text-muted-foreground">Controle</p>
            <p className="text-[10px] font-semibold">{experiment.control_count || 0}</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="text-[9px] text-muted-foreground">Teste</p>
            <p className="text-[10px] font-semibold">{experiment.test_count || 0}</p>
          </div>
        </div>

        {experiment.status === 'ativo' && (
          <div className="grid grid-cols-3 gap-1 text-center mb-2">
            <div className="bg-blue-50 rounded p-1">
              <p className="text-[9px] text-muted-foreground">Controle</p>
              <p className="text-[10px] font-bold">{Number(experiment.control_metric_value).toFixed(2)}</p>
            </div>
            <div className="bg-emerald-50 rounded p-1">
              <p className="text-[9px] text-muted-foreground">Teste</p>
              <p className="text-[10px] font-bold">{Number(experiment.test_metric_value).toFixed(2)}</p>
            </div>
            <div className="bg-purple-50 rounded p-1">
              <p className="text-[9px] text-muted-foreground">Lift</p>
              <p className="text-[10px] font-bold">{Number(experiment.lift_pct).toFixed(1)}%</p>
            </div>
          </div>
        )}

        {experiment.status === 'concluido' && (
          <div className="mb-2">
            <div className="flex items-center gap-2">
              {experiment.winner === 'teste' && <CheckCircle className="w-4 h-4 text-emerald-600" />}
              {experiment.winner === 'controle' && <CheckCircle className="w-4 h-4 text-blue-600" />}
              {experiment.winner === 'inconclusivo' && <XCircle className="w-4 h-4 text-amber-600" />}
              <span className="text-xs font-semibold">
                Vencedor: {experiment.winner === 'teste' ? '🏆 Teste' : experiment.winner === 'controle' ? '🏆 Controle' : '⚖️ Inconclusivo'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-center mt-1">
              <div className="bg-muted/50 rounded p-1">
                <p className="text-[9px] text-muted-foreground">Lift</p>
                <p className="text-[10px] font-bold">{Number(experiment.lift_pct).toFixed(1)}%</p>
              </div>
              <div className="bg-muted/50 rounded p-1">
                <p className="text-[9px] text-muted-foreground">p-value</p>
                <p className="text-[10px] font-bold">{experiment.p_value != null ? Number(experiment.p_value).toFixed(4) : '-'}</p>
              </div>
              <div className="bg-muted/50 rounded p-1">
                <p className="text-[9px] text-muted-foreground">Signif.</p>
                <p className="text-[10px] font-bold">{experiment.p_value != null ? `${((1 - Number(experiment.p_value)) * 100).toFixed(1)}%` : '-'}</p>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-1">
          {experiment.status === 'rascunho' && (
            <Button size="sm" className="flex-1 h-7 text-[10px]" onClick={() => onStart(experiment.id)}>
              <Play className="w-3 h-3 mr-1" /> Iniciar
            </Button>
          )}
          {experiment.status === 'ativo' && (
            <>
              <Button size="sm" variant="outline" className="flex-1 h-7 text-[10px]" onClick={() => onMeasure(experiment.id)}>
                <BarChart3 className="w-3 h-3 mr-1" /> Medir
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-[10px] px-2" onClick={() => onCancel(experiment.id)}>
                <XCircle className="w-3 h-3" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

const NewExperimentDialog = ({ onCreate }: { onCreate: (input: any) => void }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    hypothesis: '',
    primary_metric: 'margem_por_hora',
    min_duration_days: 14,
    min_sample_size: 10,
    min_significance: 0.95,
    control_description: '',
    test_description: '',
  });

  const handleSubmit = () => {
    if (!form.title || !form.hypothesis) return;
    onCreate(form);
    setOpen(false);
    setForm({
      title: '', hypothesis: '', primary_metric: 'margem_por_hora',
      min_duration_days: 14, min_sample_size: 10, min_significance: 0.95,
      control_description: '', test_description: '',
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-7 text-[10px]">
          <Plus className="w-3 h-3 mr-1" /> Novo
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Novo Experimento Comercial</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Título do experimento"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            className="text-xs"
          />
          <Textarea
            placeholder="Hipótese: Ex: 'Ligar 2x por semana para clientes críticos reduz churn em 15%'"
            value={form.hypothesis}
            onChange={e => setForm(f => ({ ...f, hypothesis: e.target.value }))}
            className="text-xs"
            rows={3}
          />
          <Select value={form.primary_metric} onValueChange={v => setForm(f => ({ ...f, primary_metric: v }))}>
            <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="margem_por_hora">Margem/Hora</SelectItem>
              <SelectItem value="ltv">LTV</SelectItem>
              <SelectItem value="churn">Churn</SelectItem>
              <SelectItem value="receita_incremental">Receita Incremental</SelectItem>
            </SelectContent>
          </Select>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground">Duração min (dias)</label>
              <Input type="number" value={form.min_duration_days} onChange={e => setForm(f => ({ ...f, min_duration_days: Number(e.target.value) }))} className="text-xs" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground">Amostra min</label>
              <Input type="number" value={form.min_sample_size} onChange={e => setForm(f => ({ ...f, min_sample_size: Number(e.target.value) }))} className="text-xs" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground">Signif. min</label>
              <Input type="number" step="0.01" value={form.min_significance} onChange={e => setForm(f => ({ ...f, min_significance: Number(e.target.value) }))} className="text-xs" />
            </div>
          </div>
          <Input
            placeholder="Grupo Controle: Ex: 'Abordagem atual padrão'"
            value={form.control_description}
            onChange={e => setForm(f => ({ ...f, control_description: e.target.value }))}
            className="text-xs"
          />
          <Input
            placeholder="Grupo Teste: Ex: 'Nova abordagem com foco em margem'"
            value={form.test_description}
            onChange={e => setForm(f => ({ ...f, test_description: e.target.value }))}
            className="text-xs"
          />
          <Button className="w-full" size="sm" onClick={handleSubmit}>Criar Experimento</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FarmerLOCC;
