import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';

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

// ─── Row types ─────────────────────────────────────────────────────
interface ExperimentRow {
  id: string;
  farmer_id: string;
  title: string;
  hypothesis: string;
  primary_metric: Experiment['primary_metric'];
  min_duration_days: number;
  min_sample_size: number;
  min_significance: number;
  status: Experiment['status'];
  winner: Experiment['winner'];
  control_description: string | null;
  test_description: string | null;
  control_metric_value: number;
  test_metric_value: number;
  lift_pct: number;
  p_value: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface ExperimentClientRow {
  id: string;
  experiment_id: string;
  customer_user_id: string;
  group_type: 'controle' | 'teste';
  metric_value: number;
  revenue_generated: number;
  margin_generated: number;
  calls_count: number;
  total_time_seconds: number;
}

interface ClientScoreLite {
  customer_user_id: string;
  health_score: number | string | null;
  priority_score: number | string | null;
}

interface FarmerCallLite {
  customer_user_id: string;
  revenue_generated: number | string | null;
  margin_generated: number | string | null;
  duration_seconds: number | string | null;
  follow_up_duration_seconds: number | string | null;
}

export const useFarmerExperiments = () => {
  const { user } = useAuth();
  // Lente "Ver como": a LISTA de experimentos exibida segue o id efetivo (o ALVO na
  // lente, o próprio usuário fora). As mutações (criar/iniciar/medir/cancelar) usam
  // user.id (write identity = master real) e são bloqueadas na lente pelo write-guard
  // + botões disabled. Fora da lente effectiveUserId === user.id (byte-equivalente).
  const { effectiveUserId } = useImpersonation();
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);

  const loadExperiments = useCallback(async () => {
    if (!effectiveUserId) return;
    setLoading(true);
    try {
      const { data } = (await supabase
        .from('farmer_experiments')
        .select('*')
        .eq('farmer_id', effectiveUserId)
        .order('created_at', { ascending: false })) as unknown as { data: ExperimentRow[] | null };

      if (data) {
        // Load client counts em 1 query (antes era N+1: 1 select por experimento)
        const expIds = data.map((e) => e.id);
        const { data: allClients } = expIds.length > 0
          ? ((await supabase
              .from('farmer_experiment_clients')
              .select('experiment_id, group_type')
              .in('experiment_id', expIds)) as unknown as { data: Array<{ experiment_id: string; group_type: string }> | null })
          : { data: [] as Array<{ experiment_id: string; group_type: string }> };

        // Agrupa client-side: experiment_id → { controle, teste }
        const counts = new Map<string, { controle: number; teste: number }>();
        for (const c of allClients || []) {
          const existing = counts.get(c.experiment_id) || { controle: 0, teste: 0 };
          if (c.group_type === 'controle') existing.controle++;
          else if (c.group_type === 'teste') existing.teste++;
          counts.set(c.experiment_id, existing);
        }

        const enriched: Experiment[] = data.map((exp) => {
          const c = counts.get(exp.id) || { controle: 0, teste: 0 };
          return { ...exp, control_count: c.controle, test_count: c.teste };
        });
        setExperiments(enriched);
      }
    } catch (e) {
      console.error('Error loading experiments:', e);
    } finally {
      setLoading(false);
    }
  }, [effectiveUserId]);

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
    const { error } = await supabase.from('farmer_experiments').insert({
      farmer_id: user.id,
      ...input,
    });
    if (error) {
      toast.error('Erro ao criar experimento');
      return;
    }
    toast.success('Experimento criado');
    loadExperiments();
  }, [user?.id, loadExperiments]);

  const startExperiment = useCallback(async (experimentId: string) => {
    if (!user?.id) return;

    // Load eligible clients from farmer_client_scores
    const { data: clients } = (await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, health_score, priority_score')
      .eq('farmer_id', user.id)) as unknown as { data: ClientScoreLite[] | null };

    if (!clients || clients.length < 2) {
      toast.error('Não há clientes suficientes para o experimento');
      return;
    }

    // Stratified random assignment: sort by health_score, alternate
    const sorted = [...clients].sort((a, b) => Number(b.health_score) - Number(a.health_score));
    const assignments = sorted.map((c, i) => ({
      experiment_id: experimentId,
      customer_user_id: c.customer_user_id,
      group_type: (i % 2 === 0 ? 'controle' : 'teste') as 'controle' | 'teste',
    }));

    // Insert assignments
    const { error: assignError } = await supabase
      .from('farmer_experiment_clients')
      .insert(assignments);

    if (assignError) {
      console.error('Assignment error:', assignError);
      toast.error('Erro ao distribuir clientes');
      return;
    }

    // Start experiment
    await supabase.from('farmer_experiments')
      .update({ status: 'ativo', started_at: new Date().toISOString() })
      .eq('id', experimentId);

    toast.success('Experimento iniciado com ' + assignments.length + ' clientes');
    loadExperiments();
  }, [user?.id, loadExperiments]);

  const measureExperiment = useCallback(async (experimentId: string) => {
    // Load experiment
    const { data: exp } = (await supabase
      .from('farmer_experiments')
      .select('*')
      .eq('id', experimentId)
      .single()) as unknown as { data: ExperimentRow | null };
    if (!exp || !exp.started_at) return;

    // Load experiment clients with their call data
    const { data: expClients } = (await supabase
      .from('farmer_experiment_clients')
      .select('*')
      .eq('experiment_id', experimentId)) as unknown as { data: ExperimentClientRow[] | null };

    if (!expClients?.length) return;

    const startDate = exp.started_at;
    const clientIds = expClients.map((c) => c.customer_user_id);

    // Load calls since experiment start
    const { data: calls } = (await supabase
      .from('farmer_calls')
      .select('*')
      .in('customer_user_id', clientIds)
      .gte('created_at', startDate)) as unknown as { data: FarmerCallLite[] | null };

    // Aggregate per client
    const clientMetrics = new Map<string, { revenue: number; margin: number; calls: number; time: number }>();
    for (const call of calls || []) {
      const existing = clientMetrics.get(call.customer_user_id) || { revenue: 0, margin: 0, calls: 0, time: 0 };
      existing.revenue += Number(call.revenue_generated || 0);
      existing.margin += Number(call.margin_generated || 0);
      existing.calls += 1;
      existing.time += Number(call.duration_seconds || 0) + Number(call.follow_up_duration_seconds || 0);
      clientMetrics.set(call.customer_user_id, existing);
    }

    // Update experiment clients (batch upsert único — antes era N updates sequenciais)
    const updateRows = expClients
      .map((ec) => {
        const m = clientMetrics.get(ec.customer_user_id);
        if (!m) return null;
        return {
          id: ec.id,
          experiment_id: ec.experiment_id,
          customer_user_id: ec.customer_user_id,
          group_type: ec.group_type,
          revenue_generated: m.revenue,
          margin_generated: m.margin,
          calls_count: m.calls,
          total_time_seconds: m.time,
          metric_value: computeMetric(exp.primary_metric, m),
          updated_at: new Date().toISOString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (updateRows.length > 0) {
      await supabase.from('farmer_experiment_clients').upsert(updateRows);
    }

    // Reload clients after update
    const { data: updatedClients } = (await supabase
      .from('farmer_experiment_clients')
      .select('*')
      .eq('experiment_id', experimentId)) as unknown as { data: ExperimentClientRow[] | null };

    if (!updatedClients?.length) return;

    const controlGroup = updatedClients.filter((c) => c.group_type === 'controle');
    const testGroup = updatedClients.filter((c) => c.group_type === 'teste');

    const controlAvg = controlGroup.length > 0
      ? controlGroup.reduce((s, c) => s + Number(c.metric_value), 0) / controlGroup.length
      : 0;
    const testAvg = testGroup.length > 0
      ? testGroup.reduce((s, c) => s + Number(c.metric_value), 0) / testGroup.length
      : 0;

    const liftPct = controlAvg > 0 ? ((testAvg - controlAvg) / controlAvg) * 100 : 0;

    // Simple Z-test for significance
    const pValue = calculatePValue(controlGroup.map((c) => Number(c.metric_value)),
      testGroup.map((c) => Number(c.metric_value)));

    // Check completion criteria
    const daysSinceStart = Math.floor((Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24));
    const hasMinDuration = daysSinceStart >= exp.min_duration_days;
    const hasMinSample = controlGroup.length >= exp.min_sample_size && testGroup.length >= exp.min_sample_size;
    const isSignificant = pValue !== null && (1 - pValue) >= exp.min_significance;

    let winner: Experiment['winner'] = null;
    let newStatus: Experiment['status'] = exp.status;

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

    await supabase.from('farmer_experiments')
      .update({
        control_metric_value: Math.round(controlAvg * 100) / 100,
        test_metric_value: Math.round(testAvg * 100) / 100,
        lift_pct: Math.round(liftPct * 100) / 100,
        p_value: pValue !== null ? Math.round(pValue * 10000) / 10000 : null,
        winner,
        status: newStatus,
        ended_at: newStatus === 'concluido' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', experimentId);

    toast.success(newStatus === 'concluido' ? `Experimento concluído: ${winner}` : 'Métricas atualizadas');
    loadExperiments();
  }, [loadExperiments]);

  const cancelExperiment = useCallback(async (experimentId: string) => {
    await supabase.from('farmer_experiments')
      .update({ status: 'cancelado', ended_at: new Date().toISOString() })
      .eq('id', experimentId);
    toast.success('Experimento cancelado');
    loadExperiments();
  }, [loadExperiments]);

  const loadExperimentClients = useCallback(async (experimentId: string): Promise<ExperimentClient[]> => {
    const { data } = (await supabase
      .from('farmer_experiment_clients')
      .select('*')
      .eq('experiment_id', experimentId)) as unknown as { data: ExperimentClientRow[] | null };

    if (!data) return [];

    const clientIds = data.map((c) => c.customer_user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, name')
      .in('user_id', clientIds);
    const nameMap = new Map<string, string | null>((profiles || []).map(p => [p.user_id, p.name]));

    return data.map((c) => ({
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
