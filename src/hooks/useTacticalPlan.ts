import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

// ─── Types ───────────────────────────────────────────────────────────
export interface TacticalPlan {
  id: string;
  customerId: string;
  customerName: string;
  
  // Diagnosis
  healthScore: number;
  churnRisk: number;
  mixGap: number;
  currentMarginPct: number;
  clusterAvgMarginPct: number;
  expansionPotential: number;
  
  // Strategy
  strategicObjective: string;
  customerProfile: string;
  approachStrategy: string;
  
  // Bundle
  topBundle: any;
  bundleLie: number;
  bundleProbability: number;
  bundleIncrementalMargin: number;
  bestIndividualLie: number;
  
  // AI-generated content
  diagnosticQuestions: { question: string; purpose: string; expected_insight: string }[];
  implicationQuestion: string;
  offerTransition: string;
  probableObjections: { objection: string; technical_response: string; economic_response: string; probability: number }[];
  
  // Tracking
  status: string;
  planFollowed?: boolean;
  callResult?: string;
  actualMargin?: number;
  callDurationSeconds?: number;
  objectionType?: string;
  notes?: string;
  generatedAt: string;
}

const objectiveLabels: Record<string, string> = {
  recuperacao: '🔴 Recuperação',
  expansao_mix: '🟢 Expansão de Mix',
  upsell_premium: '🔵 Up-sell Premium',
  reativacao: '🟡 Reativação',
  consolidacao_margem: '🟠 Consolidação de Margem',
};

export const getObjectiveLabel = (obj: string) => objectiveLabels[obj] || obj;

export const classifyProfile = (healthScore: number, avgSpend: number, marginPct: number, categoryCount: number): string => {
  if (avgSpend < 500 && marginPct < 20) return 'sensivel_preco';
  if (marginPct > 35 && categoryCount <= 3) return 'orientado_qualidade';
  if (avgSpend > 2000 && categoryCount >= 4 && healthScore > 60) return 'orientado_produtividade';
  return 'misto';
};

const selectObjective = (churnRisk: number, mixGap: number, marginPct: number, clusterMargin: number, daysSince: number): string => {
  if (daysSince > 90) return 'reativacao';
  if (churnRisk > 60) return 'recuperacao';
  if (mixGap > 3) return 'expansao_mix';
  if (marginPct < clusterMargin * 0.8) return 'consolidacao_margem';
  return 'upsell_premium';
};

export const useTacticalPlan = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [plans, setPlans] = useState<TacticalPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);

  // Load existing plans
  const loadPlans = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('farmer_tactical_plans' as any)
        .select('*')
        .eq('farmer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50) as any;

      if (!data) { setPlans([]); return; }

      const customerIdsSet = new Set<string>();
      data.forEach((d: any) => customerIdsSet.add(String(d.customer_user_id)));
      const customerIds: string[] = Array.from(customerIdsSet);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', customerIds) as any;

      const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p.name]));

      setPlans(data.map((d: any) => ({
        id: d.id,
        customerId: d.customer_user_id,
        customerName: profileMap.get(d.customer_user_id) || 'Cliente',
        healthScore: Number(d.health_score || 0),
        churnRisk: Number(d.churn_risk || 0),
        mixGap: Number(d.mix_gap || 0),
        currentMarginPct: Number(d.current_margin_pct || 0),
        clusterAvgMarginPct: Number(d.cluster_avg_margin_pct || 0),
        expansionPotential: Number(d.expansion_potential || 0),
        strategicObjective: d.strategic_objective,
        customerProfile: d.customer_profile,
        approachStrategy: d.approach_strategy || '',
        topBundle: d.top_bundle || {},
        bundleLie: Number(d.bundle_lie || 0),
        bundleProbability: Number(d.bundle_probability || 0),
        bundleIncrementalMargin: Number(d.bundle_incremental_margin || 0),
        bestIndividualLie: Number(d.best_individual_lie || 0),
        diagnosticQuestions: Array.isArray(d.diagnostic_questions) ? d.diagnostic_questions : [],
        implicationQuestion: d.implication_question || '',
        offerTransition: d.offer_transition || '',
        probableObjections: Array.isArray(d.probable_objections) ? d.probable_objections : [],
        status: d.status,
        planFollowed: d.plan_followed,
        callResult: d.call_result,
        actualMargin: d.actual_margin ? Number(d.actual_margin) : undefined,
        callDurationSeconds: d.call_duration_seconds,
        objectionType: d.objection_type,
        notes: d.notes,
        generatedAt: d.generated_at,
      })));
    } catch (err) {
      console.error('Error loading plans:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Generate plan for a customer
  const generatePlan = useCallback(async (customerId: string) => {
    if (!user?.id) return;
    setGenerating(customerId);

    try {
      // Load customer data
      const [
        { data: score },
        { data: profile },
        { data: bundles },
      ] = await Promise.all([
        supabase.from('farmer_client_scores').select('*').eq('customer_user_id', customerId).eq('farmer_id', user.id).single() as any,
        supabase.from('profiles').select('name, customer_type, cnae').eq('user_id', customerId).single() as any,
        supabase.from('farmer_bundle_recommendations' as any).select('*').eq('customer_user_id', customerId).eq('farmer_id', user.id).eq('status', 'pendente').order('lie_bundle', { ascending: false }).limit(1) as any,
      ]);

      if (!score) {
        toast({ variant: 'destructive', title: 'Cliente sem score calculado' });
        return;
      }

      const healthScore = Number(score.health_score || 0);
      const churnRisk = Number(score.churn_risk || 0);
      const avgSpend = Number(score.avg_monthly_spend_180d || 0);
      const marginPct = Number(score.gross_margin_pct || 0);
      const categoryCount = Number(score.category_count || 0);
      const daysSince = Number(score.days_since_last_purchase || 0);
      const expansionPotential = Number(score.expansion_score || 0);
      const revenuePotential = Number(score.revenue_potential || 0);

      // Calculate cluster average margin (from all clients)
      const { data: allScores } = await supabase
        .from('farmer_client_scores')
        .select('gross_margin_pct')
        .eq('farmer_id', user.id) as any;
      
      const clusterMargin = allScores?.length
        ? allScores.reduce((s: number, r: any) => s + Number(r.gross_margin_pct || 0), 0) / allScores.length
        : 25;

      const mixGap = Math.max(0, 8 - categoryCount); // Assume 8 categories is full mix
      const customerProfile = classifyProfile(healthScore, avgSpend, marginPct, categoryCount);
      const strategicObjective = selectObjective(churnRisk, mixGap, marginPct, clusterMargin, daysSince);

      const topBundle = bundles?.[0] || null;

      // Load historical objections from copilot events
      const { data: objectionEvents } = await supabase
        .from('farmer_copilot_events' as any)
        .select('event_data')
        .eq('event_type', 'suggestion')
        .limit(20) as any;

      const historicalObjections = (objectionEvents || [])
        .filter((e: any) => e.event_data?.intent?.startsWith('objecao'))
        .map((e: any) => e.event_data.intent)
        .slice(0, 5);

      // Call AI to generate plan content
      const { data: aiPlan, error: aiError } = await supabase.functions.invoke('generate-tactical-plan', {
        body: {
          customerContext: {
            name: profile?.name,
            cnae: profile?.cnae,
            customerType: profile?.customer_type,
            profile: customerProfile,
            healthScore,
            churnRisk,
            avgMonthlySpend: avgSpend,
            grossMarginPct: marginPct,
            categoryCount,
            daysSinceLastPurchase: daysSince,
            mixGap,
            clusterAvgMargin: clusterMargin,
            expansionPotential,
            revenuePotential,
          },
          bundleContext: topBundle ? {
            products: topBundle.bundle_products,
            lie: topBundle.lie_bundle,
            probability: topBundle.p_bundle,
            margin: topBundle.m_bundle,
          } : null,
          diagnosticData: { strategicObjective },
          historicalObjections,
        },
      });

      if (aiError) throw aiError;

      // Save to DB
      const planData = {
        farmer_id: user.id,
        customer_user_id: customerId,
        bundle_recommendation_id: topBundle?.id || null,
        health_score: healthScore,
        churn_risk: churnRisk,
        mix_gap: mixGap,
        current_margin_pct: marginPct,
        cluster_avg_margin_pct: clusterMargin,
        expansion_potential: expansionPotential,
        strategic_objective: aiPlan?.strategic_objective || strategicObjective,
        customer_profile: customerProfile,
        top_bundle: topBundle ? topBundle.bundle_products : {},
        bundle_lie: topBundle ? Number(topBundle.lie_bundle) : 0,
        bundle_probability: topBundle ? Number(topBundle.p_bundle) : 0,
        bundle_incremental_margin: topBundle ? Number(topBundle.m_bundle) : 0,
        best_individual_lie: 0,
        diagnostic_questions: aiPlan?.diagnostic_questions || [],
        implication_question: aiPlan?.implication_question || '',
        offer_transition: aiPlan?.offer_transition || '',
        probable_objections: aiPlan?.probable_objections || [],
        approach_strategy: aiPlan?.approach_strategy || '',
        status: 'gerado',
      };

      const { data: inserted } = await supabase
        .from('farmer_tactical_plans' as any)
        .insert(planData as any)
        .select('id')
        .single() as any;

      toast({ title: 'Plano tático gerado com sucesso' });
      await loadPlans();
    } catch (err: any) {
      console.error('Error generating plan:', err);
      toast({ variant: 'destructive', title: 'Erro ao gerar plano', description: err.message });
    } finally {
      setGenerating(null);
    }
  }, [user, toast, loadPlans]);

  // Record post-call results
  const recordResult = useCallback(async (planId: string, result: {
    planFollowed: boolean;
    callResult: string;
    actualMargin: number;
    callDurationSeconds: number;
    objectionType?: string;
    notes?: string;
  }) => {
    try {
      await supabase
        .from('farmer_tactical_plans' as any)
        .update({
          plan_followed: result.planFollowed,
          call_result: result.callResult,
          actual_margin: result.actualMargin,
          call_duration_seconds: result.callDurationSeconds,
          objection_type: result.objectionType || null,
          notes: result.notes || null,
          status: 'concluido',
          completed_at: new Date().toISOString(),
        } as any)
        .eq('id', planId);

      toast({ title: 'Resultado registrado' });
      await loadPlans();
    } catch (err) {
      console.error('Error recording result:', err);
    }
  }, [toast, loadPlans]);

  // Get effectiveness stats
  const getEffectivenessStats = useCallback(async () => {
    if (!user?.id) return null;

    const { data } = await supabase
      .from('farmer_tactical_plans' as any)
      .select('strategic_objective, plan_followed, actual_margin, call_duration_seconds')
      .eq('farmer_id', user.id)
      .eq('status', 'concluido') as any;

    if (!data?.length) return null;

    const byObjective: Record<string, { count: number; followed: number; totalMargin: number; totalTime: number }> = {};
    for (const d of data) {
      const obj = d.strategic_objective;
      if (!byObjective[obj]) byObjective[obj] = { count: 0, followed: 0, totalMargin: 0, totalTime: 0 };
      byObjective[obj].count++;
      if (d.plan_followed) byObjective[obj].followed++;
      byObjective[obj].totalMargin += Number(d.actual_margin || 0);
      byObjective[obj].totalTime += Number(d.call_duration_seconds || 0);
    }

    return Object.entries(byObjective).map(([obj, stats]) => ({
      objective: obj,
      label: getObjectiveLabel(obj),
      count: stats.count,
      followRate: stats.count > 0 ? Math.round((stats.followed / stats.count) * 100) : 0,
      avgMargin: stats.count > 0 ? stats.totalMargin / stats.count : 0,
      profitPerHour: stats.totalTime > 0 ? (stats.totalMargin / stats.totalTime) * 3600 : 0,
    }));
  }, [user]);

  return {
    plans,
    loading,
    generating,
    loadPlans,
    generatePlan,
    recordResult,
    getEffectivenessStats,
  };
};
