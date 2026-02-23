import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

export interface Experiment {
  id: string;
  farmer_id: string;
  title: string;
  hypothesis: string;
  primary_metric: 'margem_por_hora' | 'ltv' | 'churn' | 'receita_incremental';
  min_duration_days: number;
  min_sample_size: number;
  min_significance: number;
  status: 'rascunho' | 'ativo' | 'concluido' | 'cancelado';
  winner: 'controle' | 'teste' | 'inconclusivo' | null;
  control_description: string | null;
  test_description: string | null;
  control_metric_value: number;
  test_metric_value: number;
  lift_pct: number;
  p_value: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  control_count?: number;
  test_count?: number;
}

export interface ExperimentClient {
  id: string;
  experiment_id: string;
  customer_user_id: string;
  group_type: 'controle' | 'teste';
  metric_value: number;
  revenue_generated: number;
  margin_generated: number;
  calls_count: number;
  total_time_seconds: number;
  customer_name?: string;
}

const METRIC_LABELS: Record<string, string> = {
  margem_por_hora: 'Margem/Hora',
  ltv: 'LTV',
  churn: 'Churn (%)',
  receita_incremental: 'Receita Incremental',
};

export const useFarmerExperiments = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);

  const loadExperiments = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('farmer_experiments' as any)
        .select('*')
        .eq('farmer_id', user.id)
        .order('created_at', { ascending: false }) as any;

      if (data) {
        // Load client counts per experiment
        const enriched = await Promise.all(data.map(async (exp: any) => {
          const { data: clients } = await supabase
            .from('farmer_experiment_clients' as any)
            .select('group_type')
            .eq('experiment_id', exp.id) as any;

          return {
            ...exp,
            control_count: (clients || []).filter((c: any) => c.group_type === 'controle').length,
            test_count: (clients || []).filter((c: any) => c.group_type === 'teste').length,
          };
        }));
        setExperiments(enriched);
      }
    } catch (e) {
      console.error('Error loading experiments:', e);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadExperiments(); }, [loadExperiments]);

  const createExperiment = useCallback(async (input: {
    title: string;
    hypothesis: string;
    primary_metric: string;
    min_duration_days: number;
    min_sample_size: number;
    min_significance: number;
    control_description: string;
    test_description: string;
  }) => {
    if (!user?.id) return;
    const { error } = await supabase.from('farmer_experiments' as any).insert({
      farmer_id: user.id,
      ...input,
    } as any);
    if (error) {
      toast({ title: 'Erro ao criar experimento', variant: 'destructive' });
      return;
    }
    toast({ title: 'Experimento criado' });
    loadExperiments();
  }, [user?.id, loadExperiments, toast]);

  const startExperiment = useCallback(async (experimentId: string) => {
    if (!user?.id) return;

    // Load eligible clients from farmer_client_scores
    const { data: clients } = await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, health_score, priority_score')
      .eq('farmer_id', user.id) as any;

    if (!clients || clients.length < 2) {
      toast({ title: 'Não há clientes suficientes para o experimento', variant: 'destructive' });
      return;
    }

    // Stratified random assignment: sort by health_score, alternate
    const sorted = [...clients].sort((a: any, b: any) => Number(b.health_score) - Number(a.health_score));
    const assignments = sorted.map((c: any, i: number) => ({
      experiment_id: experimentId,
      customer_user_id: c.customer_user_id,
      group_type: i % 2 === 0 ? 'controle' : 'teste',
    }));

    // Insert assignments
    const { error: assignError } = await supabase
      .from('farmer_experiment_clients' as any)
      .insert(assignments as any);

    if (assignError) {
      console.error('Assignment error:', assignError);
      toast({ title: 'Erro ao distribuir clientes', variant: 'destructive' });
      return;
    }

    // Start experiment
    await supabase.from('farmer_experiments' as any)
      .update({ status: 'ativo', started_at: new Date().toISOString() } as any)
      .eq('id', experimentId);

    toast({ title: 'Experimento iniciado com ' + assignments.length + ' clientes' });
    loadExperiments();
  }, [user?.id, loadExperiments, toast]);

  const measureExperiment = useCallback(async (experimentId: string) => {
    // Load experiment
    const { data: exp } = await supabase
      .from('farmer_experiments' as any)
      .select('*')
      .eq('id', experimentId)
      .single() as any;
    if (!exp) return;

    // Load experiment clients with their call data
    const { data: expClients } = await supabase
      .from('farmer_experiment_clients' as any)
      .select('*')
      .eq('experiment_id', experimentId) as any;

    if (!expClients?.length) return;

    const startDate = exp.started_at;
    const clientIds = expClients.map((c: any) => c.customer_user_id);

    // Load calls since experiment start
    const { data: calls } = await supabase
      .from('farmer_calls')
      .select('*')
      .in('customer_user_id', clientIds)
      .gte('created_at', startDate) as any;

    // Aggregate per client
    const clientMetrics = new Map<string, { revenue: number; margin: number; calls: number; time: number }>();
    for (const call of (calls || [])) {
      const existing = clientMetrics.get(call.customer_user_id) || { revenue: 0, margin: 0, calls: 0, time: 0 };
      existing.revenue += Number(call.revenue_generated || 0);
      existing.margin += Number(call.margin_generated || 0);
      existing.calls += 1;
      existing.time += Number(call.duration_seconds || 0) + Number(call.follow_up_duration_seconds || 0);
      clientMetrics.set(call.customer_user_id, existing);
    }

    // Update experiment clients
    for (const ec of expClients) {
      const m = clientMetrics.get(ec.customer_user_id);
      if (m) {
        await supabase.from('farmer_experiment_clients' as any)
          .update({
            revenue_generated: m.revenue,
            margin_generated: m.margin,
            calls_count: m.calls,
            total_time_seconds: m.time,
            metric_value: computeMetric(exp.primary_metric, m),
            updated_at: new Date().toISOString(),
          } as any)
          .eq('id', ec.id);
      }
    }

    // Reload clients after update
    const { data: updatedClients } = await supabase
      .from('farmer_experiment_clients' as any)
      .select('*')
      .eq('experiment_id', experimentId) as any;

    if (!updatedClients?.length) return;

    const controlGroup = updatedClients.filter((c: any) => c.group_type === 'controle');
    const testGroup = updatedClients.filter((c: any) => c.group_type === 'teste');

    const controlAvg = controlGroup.length > 0
      ? controlGroup.reduce((s: number, c: any) => s + Number(c.metric_value), 0) / controlGroup.length
      : 0;
    const testAvg = testGroup.length > 0
      ? testGroup.reduce((s: number, c: any) => s + Number(c.metric_value), 0) / testGroup.length
      : 0;

    const liftPct = controlAvg > 0 ? ((testAvg - controlAvg) / controlAvg) * 100 : 0;

    // Simple Z-test for significance
    const pValue = calculatePValue(controlGroup.map((c: any) => Number(c.metric_value)),
      testGroup.map((c: any) => Number(c.metric_value)));

    // Check completion criteria
    const daysSinceStart = Math.floor((Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24));
    const hasMinDuration = daysSinceStart >= exp.min_duration_days;
    const hasMinSample = controlGroup.length >= exp.min_sample_size && testGroup.length >= exp.min_sample_size;
    const isSignificant = pValue !== null && (1 - pValue) >= exp.min_significance;

    let winner: string | null = null;
    let newStatus = exp.status;

    if (hasMinDuration && hasMinSample) {
      if (isSignificant) {
        winner = testAvg > controlAvg ? 'teste' : 'controle';
        newStatus = 'concluido';
      } else if (daysSinceStart >= exp.min_duration_days * 2) {
        // Double the duration without significance = inconclusive
        winner = 'inconclusivo';
        newStatus = 'concluido';
      }
    }

    await supabase.from('farmer_experiments' as any)
      .update({
        control_metric_value: Math.round(controlAvg * 100) / 100,
        test_metric_value: Math.round(testAvg * 100) / 100,
        lift_pct: Math.round(liftPct * 100) / 100,
        p_value: pValue !== null ? Math.round(pValue * 10000) / 10000 : null,
        winner,
        status: newStatus,
        ended_at: newStatus === 'concluido' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      } as any)
      .eq('id', experimentId);

    toast({ title: newStatus === 'concluido' ? `Experimento concluído: ${winner}` : 'Métricas atualizadas' });
    loadExperiments();
  }, [loadExperiments, toast]);

  const cancelExperiment = useCallback(async (experimentId: string) => {
    await supabase.from('farmer_experiments' as any)
      .update({ status: 'cancelado', ended_at: new Date().toISOString() } as any)
      .eq('id', experimentId);
    toast({ title: 'Experimento cancelado' });
    loadExperiments();
  }, [loadExperiments, toast]);

  const loadExperimentClients = useCallback(async (experimentId: string): Promise<ExperimentClient[]> => {
    const { data } = await supabase
      .from('farmer_experiment_clients' as any)
      .select('*')
      .eq('experiment_id', experimentId) as any;

    if (!data) return [];

    const clientIds = data.map((c: any) => c.customer_user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, name')
      .in('user_id', clientIds);
    const nameMap = new Map((profiles || []).map(p => [p.user_id, p.name]));

    return data.map((c: any) => ({
      ...c,
      customer_name: nameMap.get(c.customer_user_id) || 'Desconhecido',
    }));
  }, []);

  return {
    experiments,
    loading,
    createExperiment,
    startExperiment,
    measureExperiment,
    cancelExperiment,
    loadExperimentClients,
    reload: loadExperiments,
    METRIC_LABELS,
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────
function computeMetric(metric: string, data: { revenue: number; margin: number; calls: number; time: number }): number {
  const hours = data.time / 3600;
  switch (metric) {
    case 'margem_por_hora': return hours > 0 ? data.margin / hours : 0;
    case 'ltv': return data.revenue; // simplified: total revenue as proxy
    case 'churn': return data.calls > 0 ? 0 : 100; // no calls = high churn risk
    case 'receita_incremental': return data.revenue;
    default: return 0;
  }
}

function calculatePValue(control: number[], test: number[]): number | null {
  if (control.length < 2 || test.length < 2) return null;

  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = (arr: number[]) => {
    const m = mean(arr);
    return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  };

  const m1 = mean(control);
  const m2 = mean(test);
  const v1 = variance(control);
  const v2 = variance(test);
  const n1 = control.length;
  const n2 = test.length;

  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return null;

  const z = Math.abs(m2 - m1) / se;

  // Approximate two-tailed p-value using normal CDF
  const p = 2 * (1 - normalCDF(z));
  return Math.max(0, Math.min(1, p));
}

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}
