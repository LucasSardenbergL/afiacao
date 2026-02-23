import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

export interface PerformanceScore {
  id: string;
  farmerId: string;
  farmerName: string;
  calculatedAt: string;
  periodStart: string;
  periodEnd: string;

  // IEE
  ieePtplUsage: number;
  ieeObjectiveAdherence: number;
  ieeQuestionsUsage: number;
  ieeBundleOffered: number;
  ieePostCallRegistration: number;
  ieeTotal: number;

  // IPF
  ipfIncrementalMargin: number;
  ipfMarginPerHour: number;
  ipfMixExpansion: number;
  ipfLtvEvolution: number;
  ipfChurnReduction: number;
  ipfTotal: number;

  // Meta
  totalCalls: number;
  totalPlans: number;
  totalMargin: number;
  totalTimeSeconds: number;
}

export const useFarmerPerformance = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [scores, setScores] = useState<PerformanceScore[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);

  const parseScore = (d: any, nameMap: Map<string, string>): PerformanceScore => ({
    id: d.id,
    farmerId: d.farmer_id,
    farmerName: nameMap.get(d.farmer_id) || 'Farmer',
    calculatedAt: d.calculated_at,
    periodStart: d.period_start,
    periodEnd: d.period_end,
    ieePtplUsage: Number(d.iee_ptpl_usage || 0),
    ieeObjectiveAdherence: Number(d.iee_objective_adherence || 0),
    ieeQuestionsUsage: Number(d.iee_questions_usage || 0),
    ieeBundleOffered: Number(d.iee_bundle_offered || 0),
    ieePostCallRegistration: Number(d.iee_post_call_registration || 0),
    ieeTotal: Number(d.iee_total || 0),
    ipfIncrementalMargin: Number(d.ipf_incremental_margin || 0),
    ipfMarginPerHour: Number(d.ipf_margin_per_hour || 0),
    ipfMixExpansion: Number(d.ipf_mix_expansion || 0),
    ipfLtvEvolution: Number(d.ipf_ltv_evolution || 0),
    ipfChurnReduction: Number(d.ipf_churn_reduction || 0),
    ipfTotal: Number(d.ipf_total || 0),
    totalCalls: Number(d.total_calls || 0),
    totalPlans: Number(d.total_plans || 0),
    totalMargin: Number(d.total_margin || 0),
    totalTimeSeconds: Number(d.total_time_seconds || 0),
  });

  // Load scores (for a specific farmer or all farmers if admin)
  const loadScores = useCallback(async (farmerId?: string) => {
    if (!user?.id) return;
    setLoading(true);
    try {
      let query = supabase
        .from('farmer_performance_scores' as any)
        .select('*')
        .order('calculated_at', { ascending: false })
        .limit(100);

      if (farmerId) {
        query = query.eq('farmer_id', farmerId);
      }

      const { data } = await query as any;
      if (!data) { setScores([]); return; }

      const farmerIds = [...new Set(data.map((d: any) => d.farmer_id))] as string[];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', farmerIds) as any;

      const nameMap = new Map<string, string>((profiles || []).map((p: any) => [p.user_id, p.name]));
      setScores(data.map((d: any) => parseScore(d, nameMap)));
    } catch (err) {
      console.error('Error loading scores:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Calculate scores for a farmer for a given period
  const calculateScores = useCallback(async (farmerId: string, periodDays: number = 30) => {
    if (!user?.id) return;
    setCalculating(true);

    try {
      const periodEnd = new Date();
      const periodStart = new Date();
      periodStart.setDate(periodStart.getDate() - periodDays);
      const startStr = periodStart.toISOString();

      // Fetch tactical plans for the period
      const { data: plans } = await supabase
        .from('farmer_tactical_plans' as any)
        .select('*')
        .eq('farmer_id', farmerId)
        .gte('created_at', startStr) as any;

      // Fetch calls for the period
      const { data: calls } = await supabase
        .from('farmer_calls')
        .select('*')
        .eq('farmer_id', farmerId)
        .gte('created_at', startStr) as any;

      // Fetch client scores (current snapshot)
      const { data: clientScores } = await supabase
        .from('farmer_client_scores')
        .select('churn_risk, category_count, avg_monthly_spend_180d, health_score')
        .eq('farmer_id', farmerId) as any;

      // Fetch copilot sessions
      const { data: copilotSessions } = await supabase
        .from('farmer_copilot_sessions' as any)
        .select('suggestions_shown, suggestions_used')
        .eq('farmer_id', farmerId)
        .gte('created_at', startStr) as any;

      const plansArr = plans || [];
      const callsArr = calls || [];
      const clientArr = clientScores || [];
      const copilotArr = copilotSessions || [];

      const totalCalls = callsArr.length;
      const totalPlans = plansArr.length;
      const completedPlans = plansArr.filter((p: any) => p.status === 'concluido');
      const plansFollowed = completedPlans.filter((p: any) => p.plan_followed === true);

      // ── IEE Calculation ──────────────────────────────────────
      // 1. PTPL Usage: % of calls that had a plan generated before
      const callsWithPlan = totalCalls > 0 ? Math.min(100, (totalPlans / totalCalls) * 100) : 0;
      const ieePtplUsage = Math.round(callsWithPlan);

      // 2. Objective adherence: % of plans where objective was followed
      const ieeObjectiveAdherence = completedPlans.length > 0
        ? Math.round((plansFollowed.length / completedPlans.length) * 100)
        : 0;

      // 3. Questions usage: based on copilot suggestions used ratio
      const totalSugShown = copilotArr.reduce((s: number, c: any) => s + Number(c.suggestions_shown || 0), 0);
      const totalSugUsed = copilotArr.reduce((s: number, c: any) => s + Number(c.suggestions_used || 0), 0);
      const ieeQuestionsUsage = totalSugShown > 0
        ? Math.round(Math.min(100, (totalSugUsed / totalSugShown) * 100))
        : 50; // neutral if no data

      // 4. Bundle offered: % of plans with bundle_recommendation_id
      const plansWithBundle = plansArr.filter((p: any) => p.bundle_recommendation_id).length;
      const ieeBundleOffered = totalPlans > 0
        ? Math.round((plansWithBundle / totalPlans) * 100)
        : 0;

      // 5. Post-call registration: % of plans marked as completed
      const ieePostCallRegistration = totalPlans > 0
        ? Math.round((completedPlans.length / totalPlans) * 100)
        : 0;

      // IEE Total (weighted average)
      const ieeTotal = Math.round(
        ieePtplUsage * 0.25 +
        ieeObjectiveAdherence * 0.25 +
        ieeQuestionsUsage * 0.15 +
        ieeBundleOffered * 0.15 +
        ieePostCallRegistration * 0.20
      );

      // ── IPF Calculation ──────────────────────────────────────
      const totalMargin = completedPlans.reduce((s: number, p: any) => s + Number(p.actual_margin || 0), 0);
      const totalTimeSeconds = completedPlans.reduce((s: number, p: any) => s + Number(p.call_duration_seconds || 0), 0);
      const totalCallMargin = callsArr.reduce((s: number, c: any) => s + Number(c.margin_generated || 0), 0);
      const totalCallTime = callsArr.reduce((s: number, c: any) => s + Number(c.duration_seconds || 0), 0);

      const combinedMargin = totalMargin + totalCallMargin;
      const combinedTime = totalTimeSeconds + totalCallTime;

      // 1. Incremental margin score (normalized to 0-100, target R$5000/month)
      const marginTarget = 5000;
      const ipfIncrementalMargin = Math.round(Math.min(100, (combinedMargin / marginTarget) * 100));

      // 2. Margin per hour (target R$100/h = 100 score)
      const marginPerHour = combinedTime > 0 ? (combinedMargin / combinedTime) * 3600 : 0;
      const ipfMarginPerHour = Math.round(Math.min(100, marginPerHour));

      // 3. Mix expansion: avg categories across clients (target 6+)
      const avgCategories = clientArr.length > 0
        ? clientArr.reduce((s: number, c: any) => s + Number(c.category_count || 0), 0) / clientArr.length
        : 0;
      const ipfMixExpansion = Math.round(Math.min(100, (avgCategories / 6) * 100));

      // 4. LTV evolution: avg monthly spend (target R$2000)
      const avgSpend = clientArr.length > 0
        ? clientArr.reduce((s: number, c: any) => s + Number(c.avg_monthly_spend_180d || 0), 0) / clientArr.length
        : 0;
      const ipfLtvEvolution = Math.round(Math.min(100, (avgSpend / 2000) * 100));

      // 5. Churn reduction: % of clients with low churn risk (<30%)
      const lowChurnClients = clientArr.filter((c: any) => Number(c.churn_risk || 100) < 30).length;
      const ipfChurnReduction = clientArr.length > 0
        ? Math.round((lowChurnClients / clientArr.length) * 100)
        : 0;

      // IPF Total (weighted average)
      const ipfTotal = Math.round(
        ipfIncrementalMargin * 0.25 +
        ipfMarginPerHour * 0.25 +
        ipfMixExpansion * 0.20 +
        ipfLtvEvolution * 0.15 +
        ipfChurnReduction * 0.15
      );

      // Save score
      const scoreData = {
        farmer_id: farmerId,
        period_start: periodStart.toISOString().split('T')[0],
        period_end: periodEnd.toISOString().split('T')[0],
        iee_ptpl_usage: ieePtplUsage,
        iee_objective_adherence: ieeObjectiveAdherence,
        iee_questions_usage: ieeQuestionsUsage,
        iee_bundle_offered: ieeBundleOffered,
        iee_post_call_registration: ieePostCallRegistration,
        iee_total: ieeTotal,
        ipf_incremental_margin: ipfIncrementalMargin,
        ipf_margin_per_hour: ipfMarginPerHour,
        ipf_mix_expansion: ipfMixExpansion,
        ipf_ltv_evolution: ipfLtvEvolution,
        ipf_churn_reduction: ipfChurnReduction,
        ipf_total: ipfTotal,
        total_calls: totalCalls,
        total_plans: totalPlans,
        total_margin: combinedMargin,
        total_time_seconds: combinedTime,
      };

      await supabase
        .from('farmer_performance_scores' as any)
        .insert(scoreData as any);

      toast({ title: 'Índices calculados com sucesso' });
      await loadScores(farmerId);
    } catch (err: any) {
      console.error('Error calculating scores:', err);
      toast({ variant: 'destructive', title: 'Erro ao calcular índices', description: err.message });
    } finally {
      setCalculating(false);
    }
  }, [user, toast, loadScores]);

  // Get latest score for current user (IPF only view)
  const getMyLatestScore = useCallback((): PerformanceScore | null => {
    if (!user?.id || scores.length === 0) return null;
    return scores.find(s => s.farmerId === user.id) || null;
  }, [user, scores]);

  return {
    scores,
    loading,
    calculating,
    loadScores,
    calculateScores,
    getMyLatestScore,
  };
};
