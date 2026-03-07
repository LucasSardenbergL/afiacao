import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Users, AlertTriangle, Layers } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
import { KpiCard } from './KpiCard';

export function IntelligenceManagerialTab() {
  const { data: allScores, isLoading } = useQuery({
    queryKey: ['intel-all-scores'],
    queryFn: async () => {
      const { data, error } = await supabase.from('farmer_client_scores').select('*').order('priority_score', { ascending: false }).limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: allPerformance } = useQuery({
    queryKey: ['intel-all-performance'],
    queryFn: async () => {
      const { data, error } = await supabase.from('farmer_performance_scores').select('*').order('calculated_at', { ascending: false }).limit(50);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: recommendations } = useQuery({
    queryKey: ['intel-reco-adoption'],
    queryFn: async () => {
      const { data, error } = await supabase.from('farmer_recommendations').select('farmer_id, status').limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const farmerGroups = allScores?.reduce((acc, score) => {
    const fid = score.farmer_id;
    if (!acc[fid]) acc[fid] = [];
    acc[fid].push(score);
    return acc;
  }, {} as Record<string, typeof allScores>) || {};

  const recoAdoption = recommendations?.reduce((acc, r) => {
    if (!acc[r.farmer_id]) acc[r.farmer_id] = { total: 0, accepted: 0 };
    acc[r.farmer_id].total++;
    if (r.status === 'aceita') acc[r.farmer_id].accepted++;
    return acc;
  }, {} as Record<string, { total: number; accepted: number }>) || {};

  const farmerMetrics = Object.entries(farmerGroups).map(([farmerId, clients]) => {
    const avgHealth = clients.reduce((a, c) => a + Number(c.health_score || 0), 0) / clients.length;
    const atRisk = clients.filter(c => c.health_class === 'critico' || c.health_class === 'atencao').length;
    const avgMargin = clients.reduce((a, c) => a + Number(c.gross_margin_pct || 0), 0) / clients.length;
    const avgCategories = clients.reduce((a, c) => a + Number(c.category_count || 0), 0) / clients.length;
    const adoption = recoAdoption[farmerId];
    const adoptionPct = adoption && adoption.total > 0 ? (adoption.accepted / adoption.total * 100) : 0;
    return { farmerId, clientCount: clients.length, avgHealth, atRisk, avgMargin, avgCategories, adoptionPct };
  });

  const globalAvgCategories = allScores?.length
    ? allScores.reduce((a, c) => a + Number(c.category_count || 0), 0) / allScores.length
    : 0;

  if (isLoading) {
    return <div className="grid grid-cols-1 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Vendedores Ativos" value={String(farmerMetrics.length)} icon={Users} />
        <KpiCard title="Total Clientes" value={String(allScores?.length || 0)} icon={Users} />
        <KpiCard title="Clientes em Risco" value={String(allScores?.filter(c => c.health_class === 'critico' || c.health_class === 'atencao').length || 0)} icon={AlertTriangle} trend="down" />
        <KpiCard title="Mix Médio" value={globalAvgCategories.toFixed(1)} icon={Layers} subtitle="categorias/cliente" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Comparativo por Vendedor</CardTitle>
          <CardDescription className="text-xs">Saúde, risco, margem, mix e adoção de recomendações</CardDescription>
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
                  <th className="text-center py-2 font-medium text-muted-foreground">Desvio Mix</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Adoção Reco</th>
                </tr>
              </thead>
              <tbody>
                {farmerMetrics.map(fm => (
                  <tr key={fm.farmerId} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-2 font-mono">{fm.farmerId.slice(0, 8)}...</td>
                    <td className="text-center py-2">{fm.clientCount}</td>
                    <td className="text-center py-2">
                      <Badge variant={fm.avgHealth > 60 ? 'default' : 'destructive'} className="text-2xs">{fm.avgHealth.toFixed(0)}</Badge>
                    </td>
                    <td className="text-center py-2">{fm.atRisk}</td>
                    <td className="text-center py-2">{fm.avgMargin.toFixed(1)}%</td>
                    <td className="text-center py-2">{fm.avgCategories.toFixed(1)}</td>
                    <td className="text-center py-2">
                      <span className={fm.avgCategories < globalAvgCategories ? 'text-destructive' : 'text-emerald-600'}>
                        {(fm.avgCategories - globalAvgCategories).toFixed(1)}
                      </span>
                    </td>
                    <td className="text-center py-2">{fm.adoptionPct.toFixed(0)}%</td>
                  </tr>
                ))}
                {farmerMetrics.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-6 text-muted-foreground">Sem dados</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {allPerformance && allPerformance.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">IEE vs IPF por Vendedor</CardTitle>
          </CardHeader>
          <CardContent>
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
                  <Bar dataKey="ipf" fill="hsl(var(--muted-foreground))" name="IPF" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
