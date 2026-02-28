import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TrendingUp, TrendingDown, Target, Users, DollarSign, AlertTriangle,
  BarChart3, Activity, ShieldCheck, Eye, Percent, Zap, ArrowUpRight,
  ArrowDownRight, Minus, PieChart, Layers
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line, PieChart as RechartsPie, Pie, Cell } from 'recharts';

/* ─── KPI Card ─── */
function KpiCard({ title, value, subtitle, icon: Icon, trend, trendValue, className }: {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  className?: string;
}) {
  const TrendIcon = trend === 'up' ? ArrowUpRight : trend === 'down' ? ArrowDownRight : Minus;
  const trendColor = trend === 'up' ? 'text-emerald-600' : trend === 'down' ? 'text-red-500' : 'text-muted-foreground';

  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
            <p className="text-2xl font-bold tracking-tight">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="p-2 rounded-lg bg-muted">
              <Icon className="w-4 h-4 text-muted-foreground" />
            </div>
            {trendValue && (
              <div className={`flex items-center gap-0.5 text-xs font-medium ${trendColor}`}>
                <TrendIcon className="w-3 h-3" />
                {trendValue}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Operational Panel ─── */
function OperationalPanel({ farmerId }: { farmerId?: string }) {
  const { data: clientScores, isLoading: scoresLoading } = useQuery({
    queryKey: ['intel-client-scores', farmerId],
    queryFn: async () => {
      let query = supabase
        .from('farmer_client_scores')
        .select('*')
        .order('priority_score', { ascending: false })
        .limit(50);
      if (farmerId) query = query.eq('farmer_id', farmerId);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  const { data: recentCalls, isLoading: callsLoading } = useQuery({
    queryKey: ['intel-calls', farmerId],
    queryFn: async () => {
      let query = supabase
        .from('farmer_calls')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (farmerId) query = query.eq('farmer_id', farmerId);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  const { data: performanceScores } = useQuery({
    queryKey: ['intel-performance', farmerId],
    queryFn: async () => {
      let query = supabase
        .from('farmer_performance_scores')
        .select('*')
        .order('calculated_at', { ascending: false })
        .limit(1);
      if (farmerId) query = query.eq('farmer_id', farmerId);
      const { data, error } = await query;
      if (error) throw error;
      return data?.[0] || null;
    },
  });

  // Compute metrics
  const avgHealthScore = clientScores?.length
    ? (clientScores.reduce((acc, c) => acc + Number(c.health_score || 0), 0) / clientScores.length).toFixed(1)
    : '—';

  const avgPriority = clientScores?.length
    ? (clientScores.reduce((acc, c) => acc + Number(c.priority_score || 0), 0) / clientScores.length).toFixed(1)
    : '—';

  const totalMargin = recentCalls?.reduce((acc, c) => acc + Number(c.margin_generated || 0), 0) || 0;
  const totalRevenue = recentCalls?.reduce((acc, c) => acc + Number(c.revenue_generated || 0), 0) || 0;
  const ticketMedio = recentCalls?.filter(c => Number(c.revenue_generated) > 0).length
    ? (totalRevenue / recentCalls.filter(c => Number(c.revenue_generated) > 0).length)
    : 0;

  const atRiskClients = clientScores?.filter(c => (c.health_class === 'critico' || c.health_class === 'atencao')).length || 0;

  const healthDistribution = clientScores ? [
    { name: 'Saudável', value: clientScores.filter(c => c.health_class === 'saudavel').length, color: '#10b981' },
    { name: 'Estável', value: clientScores.filter(c => c.health_class === 'estavel').length, color: '#3b82f6' },
    { name: 'Atenção', value: clientScores.filter(c => c.health_class === 'atencao').length, color: '#f59e0b' },
    { name: 'Crítico', value: clientScores.filter(c => c.health_class === 'critico').length, color: '#ef4444' },
  ].filter(d => d.value > 0) : [];

  const isLoading = scoresLoading || callsLoading;

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i}><CardContent className="p-4"><Skeleton className="h-16 w-full" /></CardContent></Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          title="Margem Própria"
          value={`R$ ${totalMargin.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}
          icon={DollarSign}
          trend={totalMargin > 0 ? 'up' : 'neutral'}
          subtitle="Últimas ligações"
        />
        <KpiCard
          title="Ticket Médio"
          value={`R$ ${ticketMedio.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}
          icon={Target}
          trend="neutral"
        />
        <KpiCard
          title="Health Score Médio"
          value={avgHealthScore}
          icon={Activity}
          subtitle="Carteira"
          trend={Number(avgHealthScore) > 60 ? 'up' : 'down'}
        />
        <KpiCard
          title="Priority Score Médio"
          value={avgPriority}
          icon={Zap}
          subtitle="Diário"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Health Distribution */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Distribuição de Saúde da Carteira</CardTitle>
          </CardHeader>
          <CardContent>
            {healthDistribution.length > 0 ? (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsPie>
                    <Pie data={healthDistribution} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, value }) => `${name}: ${value}`}>
                      {healthDistribution.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip />
                  </RechartsPie>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">Sem dados de saúde</p>
            )}
          </CardContent>
        </Card>

        {/* At Risk Clients */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Clientes em Risco
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold mb-2">{atRiskClients}</div>
            <p className="text-xs text-muted-foreground mb-3">Clientes classificados como Atenção ou Crítico</p>
            <div className="space-y-2">
              {clientScores?.filter(c => c.health_class === 'critico' || c.health_class === 'atencao')
                .slice(0, 5)
                .map(c => (
                  <div key={c.id} className="flex items-center justify-between text-xs">
                    <span className="truncate">{c.customer_user_id.slice(0, 8)}...</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={c.health_class === 'critico' ? 'destructive' : 'secondary'} className="text-2xs">
                        {c.health_class}
                      </Badge>
                      <span className="text-muted-foreground">HS: {Number(c.health_score).toFixed(0)}</span>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* SPIN Score & IEE */}
      {performanceScores && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Índice de Execução Estratégica (IEE)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'PTPL', value: performanceScores.iee_ptpl_usage },
                { label: 'Aderência Obj.', value: performanceScores.iee_objective_adherence },
                { label: 'Perguntas', value: performanceScores.iee_questions_usage },
                { label: 'Bundle Oferecido', value: performanceScores.iee_bundle_offered },
                { label: 'Registro Pós-Call', value: performanceScores.iee_post_call_registration },
              ].map(item => (
                <div key={item.label} className="text-center">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="text-lg font-bold">{Number(item.value || 0).toFixed(0)}%</p>
                  <Progress value={Number(item.value || 0)} className="h-1.5 mt-1" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ─── Managerial Panel ─── */
function ManagerialPanel() {
  const { data: allScores, isLoading } = useQuery({
    queryKey: ['intel-all-scores'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('farmer_client_scores')
        .select('*')
        .order('priority_score', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: allPerformance } = useQuery({
    queryKey: ['intel-all-performance'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('farmer_performance_scores')
        .select('*')
        .order('calculated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
  });

  // Group by farmer
  const farmerGroups = allScores?.reduce((acc, score) => {
    const fid = score.farmer_id;
    if (!acc[fid]) acc[fid] = [];
    acc[fid].push(score);
    return acc;
  }, {} as Record<string, typeof allScores>) || {};

  const farmerMetrics = Object.entries(farmerGroups).map(([farmerId, clients]) => {
    const avgHealth = clients.reduce((a, c) => a + Number(c.health_score || 0), 0) / clients.length;
    const atRisk = clients.filter(c => c.health_class === 'critico' || c.health_class === 'atencao').length;
    const avgMargin = clients.reduce((a, c) => a + Number(c.gross_margin_pct || 0), 0) / clients.length;
    const avgCategories = clients.reduce((a, c) => a + Number(c.category_count || 0), 0) / clients.length;
    return { farmerId, clientCount: clients.length, avgHealth, atRisk, avgMargin, avgCategories };
  });

  if (isLoading) {
    return <div className="grid grid-cols-1 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Vendedores Ativos" value={String(farmerMetrics.length)} icon={Users} />
        <KpiCard title="Total Clientes" value={String(allScores?.length || 0)} icon={Users} />
        <KpiCard
          title="Clientes em Risco (Total)"
          value={String(allScores?.filter(c => c.health_class === 'critico' || c.health_class === 'atencao').length || 0)}
          icon={AlertTriangle}
          trend="down"
        />
        <KpiCard
          title="Mix Médio (Categorias)"
          value={(allScores?.reduce((a, c) => a + Number(c.category_count || 0), 0) / (allScores?.length || 1)).toFixed(1)}
          icon={Layers}
        />
      </div>

      {/* Comparativo por Vendedor */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Comparativo por Vendedor</CardTitle>
          <CardDescription className="text-xs">Saúde média, clientes em risco e mix por vendedor</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium text-muted-foreground">Vendedor</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Clientes</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">HS Médio</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Em Risco</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Margem %</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Mix</th>
                </tr>
              </thead>
              <tbody>
                {farmerMetrics.map(fm => (
                  <tr key={fm.farmerId} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-2 font-mono">{fm.farmerId.slice(0, 8)}...</td>
                    <td className="text-center py-2">{fm.clientCount}</td>
                    <td className="text-center py-2">
                      <Badge variant={fm.avgHealth > 60 ? 'default' : 'destructive'} className="text-2xs">
                        {fm.avgHealth.toFixed(0)}
                      </Badge>
                    </td>
                    <td className="text-center py-2">{fm.atRisk}</td>
                    <td className="text-center py-2">{fm.avgMargin.toFixed(1)}%</td>
                    <td className="text-center py-2">{fm.avgCategories.toFixed(1)}</td>
                  </tr>
                ))}
                {farmerMetrics.length === 0 && (
                  <tr><td colSpan={6} className="text-center py-6 text-muted-foreground">Sem dados de vendedores</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Adoção de Recomendações */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Adoção de Recomendações por Vendedor</CardTitle>
        </CardHeader>
        <CardContent>
          {allPerformance && allPerformance.length > 0 ? (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={allPerformance.slice(0, 10).map(p => ({
                  name: p.farmer_id.slice(0, 6),
                  iee: Number(p.iee_total || 0),
                  ipf: Number(p.ipf_total || 0),
                }))}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" className="text-xs" />
                  <YAxis className="text-xs" />
                  <RechartsTooltip />
                  <Bar dataKey="iee" fill="hsl(var(--primary))" name="IEE" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="ipf" fill="hsl(var(--secondary))" name="IPF" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">Sem dados de performance</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Strategic Panel ─── */
function StrategicPanel() {
  const { data: marginAudit, isLoading } = useQuery({
    queryKey: ['intel-margin-audit'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('margin_audit_log')
        .select('*')
        .order('calculated_at', { ascending: false })
        .limit(100);
      if (error) {
        console.error('Margin audit error:', error);
        return [];
      }
      return data || [];
    },
  });

  const { data: allScores } = useQuery({
    queryKey: ['intel-strategic-scores'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('farmer_client_scores')
        .select('*')
        .limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const totalMarginReal = marginAudit?.reduce((a, r) => a + Number(r.margin_real || 0), 0) || 0;
  const totalMarginPotential = marginAudit?.reduce((a, r) => a + Number(r.margin_potential || 0), 0) || 0;
  const totalGap = totalMarginPotential - totalMarginReal;
  const gapPct = totalMarginPotential > 0 ? ((totalGap / totalMarginPotential) * 100) : 0;

  // LTV projetado (estimativa simples)
  const avgSpend = allScores?.length
    ? allScores.reduce((a, c) => a + Number(c.avg_monthly_spend_180d || 0), 0) / allScores.length
    : 0;
  const ltvEstimate = avgSpend * 12 * 3; // 3 years projection

  // Concentração de margem (top 20%)
  const sortedByRevenue = [...(allScores || [])].sort((a, b) => Number(b.revenue_potential || 0) - Number(a.revenue_potential || 0));
  const top20Count = Math.ceil(sortedByRevenue.length * 0.2);
  const top20Revenue = sortedByRevenue.slice(0, top20Count).reduce((a, c) => a + Number(c.revenue_potential || 0), 0);
  const totalRevenue = sortedByRevenue.reduce((a, c) => a + Number(c.revenue_potential || 0), 0);
  const concentrationPct = totalRevenue > 0 ? (top20Revenue / totalRevenue * 100) : 0;

  if (isLoading) {
    return <div className="grid grid-cols-2 gap-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Algoritmo A – Margin Gap */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck className="w-4 h-4 text-amber-500" />
          <span className="text-xs font-semibold text-amber-600 uppercase tracking-wider">Algoritmo A — Auditoria de Margem (Confidencial)</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard title="Margem Real" value={`R$ ${totalMarginReal.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={DollarSign} />
          <KpiCard title="Margem Potencial" value={`R$ ${totalMarginPotential.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={TrendingUp} />
          <KpiCard title="Gap de Margem" value={`R$ ${totalGap.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={TrendingDown} trend="down" trendValue={`${gapPct.toFixed(1)}%`} />
          <KpiCard title="Registros Auditoria" value={String(marginAudit?.length || 0)} icon={Eye} />
        </div>
      </div>

      {/* Strategic KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="LTV Projetado (3a)" value={`R$ ${ltvEstimate.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={BarChart3} subtitle="Estimativa média" />
        <KpiCard title="Concentração Top 20%" value={`${concentrationPct.toFixed(1)}%`} icon={PieChart} subtitle="da receita total" />
        <KpiCard title="Clientes Total" value={String(allScores?.length || 0)} icon={Users} />
        <KpiCard title="Margem Bruta Média" value={`${(allScores?.reduce((a, c) => a + Number(c.gross_margin_pct || 0), 0) / (allScores?.length || 1)).toFixed(1)}%`} icon={Percent} />
      </div>

      {/* Margin Audit Table */}
      {marginAudit && marginAudit.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Log de Auditoria de Margem</CardTitle>
            <CardDescription className="text-xs">Últimos registros do Algoritmo A</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium text-muted-foreground">Cliente</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">M. Real</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">M. Potencial</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">Gap</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">Gap %</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {marginAudit.slice(0, 20).map(row => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                      <td className="py-2 font-mono">{row.customer_user_id.slice(0, 8)}...</td>
                      <td className="text-center py-2">R$ {Number(row.margin_real).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2">R$ {Number(row.margin_potential).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2 text-red-500">R$ {Number(row.margin_gap).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2">{Number(row.gap_pct).toFixed(1)}%</td>
                      <td className="text-right py-2 text-muted-foreground">{new Date(row.calculated_at).toLocaleDateString('pt-BR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ─── Main Page ─── */
export default function IntelligenceDashboard() {
  const { user } = useAuth();
  const { isAdmin, isStaff } = useUserRole();
  const { commercialRole, canViewManagerial, canViewStrategic, isSuperAdmin, loading } = useCommercialRole();

  // Determine default tab based on role
  const defaultTab = canViewStrategic ? 'strategic' : canViewManagerial ? 'managerial' : 'operational';

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Inteligência Comercial</h1>
          <p className="text-sm text-muted-foreground">
            Análise de performance, carteira e métricas estratégicas
          </p>
        </div>
        <div className="flex items-center gap-2">
          {commercialRole && (
            <Badge variant="outline" className="text-xs capitalize">
              {commercialRole.replace('_', ' ')}
            </Badge>
          )}
          {isSuperAdmin && (
            <Badge className="text-xs bg-amber-500/20 text-amber-700 border-amber-500/30">
              <ShieldCheck className="w-3 h-3 mr-1" />
              Acesso Total
            </Badge>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab}>
        <TabsList className="h-8">
          <TabsTrigger value="operational" className="text-xs px-3 h-7">
            <Activity className="w-3 h-3 mr-1" />
            Operacional
          </TabsTrigger>
          {(canViewManagerial || isAdmin) && (
            <TabsTrigger value="managerial" className="text-xs px-3 h-7">
              <BarChart3 className="w-3 h-3 mr-1" />
              Gerencial
            </TabsTrigger>
          )}
          {(canViewStrategic || isAdmin) && (
            <TabsTrigger value="strategic" className="text-xs px-3 h-7">
              <ShieldCheck className="w-3 h-3 mr-1" />
              Estratégico
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="operational" className="mt-4">
          <OperationalPanel farmerId={(!canViewManagerial && !isAdmin) ? user?.id : undefined} />
        </TabsContent>

        {(canViewManagerial || isAdmin) && (
          <TabsContent value="managerial" className="mt-4">
            <ManagerialPanel />
          </TabsContent>
        )}

        {(canViewStrategic || isAdmin) && (
          <TabsContent value="strategic" className="mt-4">
            <StrategicPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
