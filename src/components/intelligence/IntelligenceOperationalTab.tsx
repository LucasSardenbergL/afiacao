import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { DollarSign, Target, Activity, Zap, AlertTriangle } from 'lucide-react';
import { ResponsiveContainer, PieChart as RechartsPie, Pie, Cell, Tooltip as RechartsTooltip } from 'recharts';
import { KpiCard } from './KpiCard';

interface OperationalTabProps {
  farmerId?: string;
}

export function IntelligenceOperationalTab({ farmerId }: OperationalTabProps) {
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Margem Própria" value={`R$ ${totalMargin.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={DollarSign} trend={totalMargin > 0 ? 'up' : 'neutral'} subtitle="Últimas ligações" />
        <KpiCard title="Ticket Médio" value={`R$ ${ticketMedio.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={Target} trend="neutral" />
        <KpiCard title="Health Score Médio" value={avgHealthScore} icon={Activity} subtitle="Carteira" trend={Number(avgHealthScore) > 60 ? 'up' : 'down'} />
        <KpiCard title="Priority Score Médio" value={avgPriority} icon={Zap} subtitle="Diário" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                      {healthDistribution.map((entry, idx) => <Cell key={idx} fill={entry.color} />)}
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

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Clientes em Risco
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold mb-2">{atRiskClients}</div>
            <p className="text-xs text-muted-foreground mb-3">Classificados como Atenção ou Crítico</p>
            <div className="space-y-2">
              {clientScores?.filter(c => c.health_class === 'critico' || c.health_class === 'atencao')
                .slice(0, 5)
                .map(c => (
                  <div key={c.id} className="flex items-center justify-between text-xs">
                    <span className="truncate">{c.customer_user_id.slice(0, 8)}...</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={c.health_class === 'critico' ? 'destructive' : 'secondary'} className="text-2xs">{c.health_class}</Badge>
                      <span className="text-muted-foreground">HS: {Number(c.health_score).toFixed(0)}</span>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      </div>

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
