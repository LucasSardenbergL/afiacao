import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { selectObjective, clampRecencyCapDays } from '@/lib/scoring/objective';
import { ownersAtivosDoAlvo } from '@/lib/carteira/escopo-clientes';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────────────
export type PlanType = 'essencial' | 'estrategico';

// JSON shape stored in top_bundle / second_bundle columns — schema is dynamic
// (varies by bundle engine version), so kept as Record.
export type BundleSnapshot = Record<string, unknown>;

export interface TacticalPlan {
  id: string;
  customerId: string;
  customerName: string;
  planType: PlanType;

  // Diagnosis
  healthScore: number;
  churnRisk: number;
  mixGap: number;
  currentMarginPct: number;
  clusterAvgMarginPct: number | null;
  expansionPotential: number;

  // Strategy
  strategicObjective: string;
  customerProfile: string;
  approachStrategy: string;
  approachStrategyB: string;

  // Bundle
  topBundle: BundleSnapshot;
  secondBundle: BundleSnapshot;
  bundleLie: number;
  bundleProbability: number;
  bundleIncrementalMargin: number;
  bestIndividualLie: number;

  // AI-generated content
  diagnosticQuestions: { question: string; purpose: string; expected_insight: string }[];
  implicationQuestion: string;
  offerTransition: string;
  probableObjections: { objection: string; technical_response: string; economic_response: string; probability: number }[];

  // Strategic-only fields
  ltvProjection: { current_annual: number; projected_annual: number; growth_pct: number } | null;
  expectedResult: { best_case_margin: number; likely_margin: number; worst_case_margin: number } | null;
  operationalRisks: string[];

  // Efficiency
  estimatedProfitPerHour: number;

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

// ─── Row + helper types ────────────────────────────────────────────
interface TacticalPlanRow {
  id: string;
  customer_user_id: string;
  plan_type: PlanType | null;
  health_score: number | string | null;
  churn_risk: number | string | null;
  mix_gap: number | string | null;
  current_margin_pct: number | string | null;
  cluster_avg_margin_pct: number | string | null;
  expansion_potential: number | string | null;
  strategic_objective: string;
  customer_profile: string;
  approach_strategy: string | null;
  approach_strategy_b: string | null;
  top_bundle: BundleSnapshot | null;
  second_bundle: BundleSnapshot | null;
  bundle_lie: number | string | null;
  bundle_probability: number | string | null;
  bundle_incremental_margin: number | string | null;
  best_individual_lie: number | string | null;
  diagnostic_questions: TacticalPlan['diagnosticQuestions'] | unknown;
  implication_question: string | null;
  offer_transition: string | null;
  probable_objections: TacticalPlan['probableObjections'] | unknown;
  ltv_projection: TacticalPlan['ltvProjection'] | unknown;
  expected_result: TacticalPlan['expectedResult'] | unknown;
  operational_risks: string[] | unknown;
  status: string;
  plan_followed?: boolean | null;
  call_result?: string | null;
  actual_margin?: number | string | null;
  call_duration_seconds?: number | null;
  objection_type?: string | null;
  notes?: string | null;
  generated_at: string;
}

interface ClientScoreFull {
  farmer_id: string | null; // dono da carteira-Omie (Opção A) — escopa o cluster de margem
  health_score: number | string | null;
  churn_risk: number | string | null;
  avg_monthly_spend_180d: number | string | null;
  gross_margin_pct: number | string | null;
  category_count: number | string | null;
  days_since_last_purchase: number | string | null;
  expansion_score: number | string | null;
  revenue_potential: number | string | null;
  sales_history_status: string | null;
}

interface ProfileLite {
  user_id?: string;
  name: string | null;
  customer_type?: string | null;
  cnae?: string | null;
}

interface BundleRow {
  id: string;
  bundle_products: BundleSnapshot;
  lie_bundle: number | string | null;
  p_bundle: number | string | null;
  m_bundle: number | string | null;
}

interface CopilotEventRow {
  event_data: { intent?: string } | Record<string, unknown> | null;
}

interface EffectivenessRow {
  strategic_objective: string;
  plan_followed: boolean | null;
  actual_margin: number | string | null;
  call_duration_seconds: number | string | null;
  plan_type: PlanType | null;
}

interface AiPlanResponse {
  strategic_objective?: string;
  diagnostic_questions?: TacticalPlan['diagnosticQuestions'];
  implication_question?: string;
  offer_transition?: string;
  probable_objections?: TacticalPlan['probableObjections'];
  approach_strategy?: string;
  approach_strategy_b?: string;
  ltv_projection?: TacticalPlan['ltvProjection'];
  expected_result?: TacticalPlan['expectedResult'];
  operational_risks?: string[];
}

interface DiagnosticData {
  strategicObjective: string;
  secondBundle?: {
    products: BundleSnapshot;
    lie: number | string | null;
    probability: number | string | null;
    margin: number | string | null;
  };
}

export interface EfficiencyCheck {
  estimatedProfitPerHour: number;
  threshold: number;
  isAboveThreshold: boolean;
}

const objectiveLabels: Record<string, string> = {
  recuperacao: '🔴 Recuperação',
  expansao_mix: '🟢 Expansão de Mix',
  upsell_premium: '🔵 Up-sell Premium',
  reativacao: '🟡 Reativação',
  ativacao: '🆕 Ativação',
  consolidacao_margem: '🟠 Consolidação de Margem',
};

export const getObjectiveLabel = (obj: string) => objectiveLabels[obj] || obj;

const classifyProfile = (healthScore: number, avgSpend: number, marginPct: number, categoryCount: number): string => {
  if (avgSpend < 500 && marginPct < 20) return 'sensivel_preco';
  if (marginPct > 35 && categoryCount <= 3) return 'orientado_qualidade';
  if (avgSpend > 2000 && categoryCount >= 4 && healthScore > 60) return 'orientado_produtividade';
  return 'misto';
};

const PROFIT_PER_HOUR_THRESHOLD = 50; // R$/h configurable threshold

export const useTacticalPlan = () => {
  const { user } = useAuth();
  // Lente "Ver como" + COBERTURA (#980): as leituras de EXIBIÇÃO (lista de planos, plano ativo do
  // cliente) seguem a VISIBILIDADE de carteira do id efetivo — carteira própria + carteiras
  // cobertas (fetchOwnerScope/ownersAtivosDoAlvo). O id efetivo é o ALVO na lente, o próprio
  // usuário fora. A RLS de farmer_tactical_plans é staff-vê-tudo (NÃO escopa por farmer_id), então
  // o escopo de leitura é responsabilidade do app. A GERAÇÃO (checkEfficiency/generatePlan) e o
  // registro de resultado seguem user.id (write identity = master real) e são bloqueados na lente
  // pelo write-guard + botões disabled. A POSSE gravada (farmer_id) é o DONO da carteira do cliente
  // (score.farmer_id), nunca o executor. Fora da lente effectiveUserId === user.id.
  const { effectiveUserId } = useImpersonation();
  const [plans, setPlans] = useState<TacticalPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);

  const parsePlan = (d: TacticalPlanRow, profileMap: Map<string, string>): TacticalPlan => {
    const topBundle: BundleSnapshot = d.top_bundle || {};
    const secondBundle: BundleSnapshot = d.second_bundle || {};
    const ltvProjection = d.ltv_projection;
    const expectedResult = d.expected_result;
    const avgCallMinutes = 15;
    const bundleLie = Number(d.bundle_lie || 0);
    const estimatedProfitPerHour = bundleLie > 0 ? (bundleLie / (avgCallMinutes / 60)) : 0;

    return {
      id: d.id,
      customerId: d.customer_user_id,
      customerName: profileMap.get(d.customer_user_id) || 'Cliente',
      planType: d.plan_type || 'essencial',
      healthScore: Number(d.health_score || 0),
      churnRisk: Number(d.churn_risk || 0),
      mixGap: Number(d.mix_gap || 0),
      currentMarginPct: Number(d.current_margin_pct || 0),
      clusterAvgMarginPct: d.cluster_avg_margin_pct == null ? null : Number(d.cluster_avg_margin_pct),
      expansionPotential: Number(d.expansion_potential || 0),
      strategicObjective: d.strategic_objective,
      customerProfile: d.customer_profile,
      approachStrategy: d.approach_strategy || '',
      approachStrategyB: d.approach_strategy_b || '',
      topBundle,
      secondBundle,
      bundleLie,
      bundleProbability: Number(d.bundle_probability || 0),
      bundleIncrementalMargin: Number(d.bundle_incremental_margin || 0),
      bestIndividualLie: Number(d.best_individual_lie || 0),
      diagnosticQuestions: Array.isArray(d.diagnostic_questions)
        ? (d.diagnostic_questions as TacticalPlan['diagnosticQuestions'])
        : [],
      implicationQuestion: d.implication_question || '',
      offerTransition: d.offer_transition || '',
      probableObjections: Array.isArray(d.probable_objections)
        ? (d.probable_objections as TacticalPlan['probableObjections'])
        : [],
      ltvProjection: ltvProjection && typeof ltvProjection === 'object'
        ? (ltvProjection as TacticalPlan['ltvProjection'])
        : null,
      expectedResult: expectedResult && typeof expectedResult === 'object'
        ? (expectedResult as TacticalPlan['expectedResult'])
        : null,
      operationalRisks: Array.isArray(d.operational_risks) ? (d.operational_risks as string[]) : [],
      estimatedProfitPerHour,
      status: d.status,
      planFollowed: d.plan_followed ?? undefined,
      callResult: d.call_result ?? undefined,
      actualMargin: d.actual_margin ? Number(d.actual_margin) : undefined,
      callDurationSeconds: d.call_duration_seconds ?? undefined,
      objectionType: d.objection_type ?? undefined,
      notes: d.notes ?? undefined,
      generatedAt: d.generated_at,
    };
  };

  // Visibilidade de carteira p/ LEITURA: dono efetivo + carteiras que ele cobre (cobertura ativa e
  // dentro da validade). Reproduz, com a sessão atual, o que carteira_visivel_para daria — preciso
  // porque a RLS de farmer_tactical_plans é staff-vê-tudo (não escopa por farmer_id), então o
  // escopo é do app. baseId = effectiveUserId (alvo na lente, próprio fora).
  const fetchOwnerScope = useCallback(async (baseId: string): Promise<string[]> => {
    const { data: cov, error } = (await supabase
      .from('carteira_coverage')
      .select('covered_user_id, valid_until')
      .eq('covering_user_id', baseId)
      .eq('active', true)) as unknown as { data: { covered_user_id: string; valid_until: string | null }[] | null; error: unknown };
    // Erro na cobertura degrada para [próprio] (fail-closed: não vaza carteira alheia) mas NÃO
    // silencioso — senão "a cobertura sumiu" passa despercebido (achado /codex challenge P2).
    if (error) console.error('fetchOwnerScope: falha lendo carteira_coverage; escopo cai p/ próprio', error);
    return ownersAtivosDoAlvo(cov ?? [], baseId, new Date().toISOString());
  }, []);

  // Load existing plans
  const loadPlans = useCallback(async () => {
    if (!effectiveUserId) return;
    setLoading(true);
    try {
      const owners = await fetchOwnerScope(effectiveUserId);
      const { data } = (await supabase
        .from('farmer_tactical_plans')
        .select('*')
        .in('farmer_id', owners)
        .order('created_at', { ascending: false })
        .limit(50)) as unknown as { data: TacticalPlanRow[] | null };

      if (!data) { setPlans([]); return; }

      const customerIdsSet = new Set<string>();
      data.forEach((d) => customerIdsSet.add(String(d.customer_user_id)));
      const customerIds: string[] = Array.from(customerIdsSet);
      const { data: profiles } = (await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', customerIds)) as unknown as { data: ProfileLite[] | null };

      const profileMap = new Map<string, string>(
        (profiles || []).map((p) => [p.user_id ?? '', p.name ?? 'Cliente'])
      );
      setPlans(data.map((d) => parsePlan(d, profileMap)));
    } catch (err) {
      console.error('Error loading plans:', err);
    } finally {
      setLoading(false);
    }
  }, [effectiveUserId, fetchOwnerScope]);

  // Check efficiency before generating
  const checkEfficiency = useCallback(async (customerId: string): Promise<EfficiencyCheck> => {
    if (!user?.id) return { estimatedProfitPerHour: 0, threshold: PROFIT_PER_HOUR_THRESHOLD, isAboveThreshold: false };

    const { data: score } = (await supabase
      .from('farmer_client_scores')
      .select('revenue_potential, avg_monthly_spend_180d, gross_margin_pct')
      // Opção A: 1 linha por cliente (customer_user_id único). NÃO filtrar por farmer_id —
      // quebrava sob a lente / cliente de outro dono → "sem score" falso; RLS gateia a visibilidade.
      .eq('customer_user_id', customerId)
      .single()) as unknown as { data: Pick<ClientScoreFull, 'revenue_potential' | 'avg_monthly_spend_180d' | 'gross_margin_pct'> | null };

    const revPotential = Number(score?.revenue_potential || 0);
    const avgSpend = Number(score?.avg_monthly_spend_180d || 0);
    const marginPct = Number(score?.gross_margin_pct || 0);
    const estimatedMarginPerCall = (revPotential > 0 ? revPotential : avgSpend) * (marginPct / 100) * 0.1;
    const avgCallMinutes = 15;
    const estimatedProfitPerHour = estimatedMarginPerCall / (avgCallMinutes / 60);

    return {
      estimatedProfitPerHour,
      threshold: PROFIT_PER_HOUR_THRESHOLD,
      isAboveThreshold: estimatedProfitPerHour >= PROFIT_PER_HOUR_THRESHOLD,
    };
  }, [user]);

  // Generate plan for a customer
  const generatePlan = useCallback(async (customerId: string, planType: PlanType = 'essencial') => {
    if (!user?.id) return;
    setGenerating(customerId);

    try {
      const [
        { data: score },
        { data: profile },
        { data: recencyCapRow },
      ] = await Promise.all([
        // Opção A: lookup por customer_user_id (único); sem farmer_id (RLS gateia). Ver checkEfficiency.
        supabase.from('farmer_client_scores').select('*').eq('customer_user_id', customerId).single() as unknown as Promise<{ data: ClientScoreFull | null }>,
        supabase.from('profiles').select('name, customer_type, cnae').eq('user_id', customerId).single() as unknown as Promise<{ data: ProfileLite | null }>,
        // Teto de recência (hs_recency_cap_days) — fronteira reativacao/recuperacao em selectObjective
        // ACOMPANHA o teto do modelo (não hardcode). Ausente → clampRecencyCapDays default 180. limit(1)
        // pra maybeSingle nunca lançar em chave duplicada (não quebrar a geração por quirk de config).
        supabase.from('farmer_algorithm_config').select('value').eq('key', 'hs_recency_cap_days').limit(1).maybeSingle() as unknown as Promise<{ data: { value: number | string | null } | null }>,
      ]);

      if (!score) {
        toast.error('Cliente sem score calculado');
        return;
      }

      // [GUARD money-path] POSSE do plano = DONO da carteira do cliente (score.farmer_id, Opção A),
      // NUNCA o executor logado. A RLS de farmer_tactical_plans é staff-vê-tudo (não escopa por
      // farmer_id), então o campo é o ÚNICO mecanismo de posse: gravar user.id poluiria a carteira
      // do gestor sob cobertura (#980) e sumiria da carteira do dono. O bundle (multi por
      // (customer,farmer)) e o cluster também escopam pelo dono. farmer_id null = corrupção →
      // precisão>recall: abortar (não gravar sob dono errado, não cair pro viewer, não fabricar).
      const ownerId = score.farmer_id;
      if (!ownerId) {
        toast.error('Cliente sem dono de carteira definido — não é possível gerar o plano');
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
      const salesHistoryStatus = score.sales_history_status ?? null;

      // [GUARD money-path] Cluster = média de margem dos PARES da carteira do DONO (ownerId), não
      // de quem está logado. Sob cobertura (#980) o viewer gera plano de cliente de OUTRO dono;
      // benchmarkar por user.id daria cluster errado e, p/ gestor sem carteira, fabricava 25
      // (margem<20 forçando consolidacao a esmo). A RLS fcs_select_carteira deixa o cobridor ler a
      // carteira do coberto (carteira_visivel_para via carteira_coverage). Exclui o próprio cliente
      // (peer benchmark) e exige ≥1 par com margem finita; sem par → null (selectObjective trata;
      // nada de 25).
      let clusterMargin: number | null = null;
      {
        const { data: peers } = (await supabase
          .from('farmer_client_scores')
          .select('gross_margin_pct')
          .eq('farmer_id', ownerId)
          .neq('customer_user_id', customerId)) as unknown as { data: Pick<ClientScoreFull, 'gross_margin_pct'>[] | null };
        const peerMargins = (peers ?? [])
          .filter((r) => r.gross_margin_pct != null)
          .map((r) => Number(r.gross_margin_pct))
          .filter((m) => Number.isFinite(m));
        if (peerMargins.length >= 1) {
          clusterMargin = peerMargins.reduce((s, m) => s + m, 0) / peerMargins.length;
        }
      }

      // Bundle pendente do cliente sob a carteira do DONO (ownerId), não do viewer. A tabela é
      // multi por (customer_user_id, farmer_id) — NÃO basta dropar o farmer_id (traria bundle de
      // outro dono); filtrar pelo dono é o correto. A RLS fbrec_select_carteira deixa o cobridor
      // ler via carteira_visivel_para. limit(2): top + second p/ o plano estratégico.
      const { data: bundles } = (await supabase
        .from('farmer_bundle_recommendations')
        .select('*')
        .eq('customer_user_id', customerId)
        .eq('farmer_id', ownerId)
        .eq('status', 'pendente')
        .order('lie_bundle', { ascending: false })
        .limit(2)) as unknown as { data: BundleRow[] | null };

      const mixGap = Math.max(0, 8 - categoryCount);
      const customerProfile = classifyProfile(healthScore, avgSpend, marginPct, categoryCount);
      const recencyCapDays = clampRecencyCapDays(recencyCapRow?.value);
      const strategicObjective = selectObjective(churnRisk, mixGap, marginPct, clusterMargin, daysSince, recencyCapDays, salesHistoryStatus);

      const topBundle = bundles?.[0] || null;
      const secondBundle = bundles?.[1] || null;

      const { data: objectionEvents } = (await supabase
        .from('farmer_copilot_events')
        .select('event_data')
        .eq('event_type', 'suggestion')
        .limit(20)) as unknown as { data: CopilotEventRow[] | null };

      const historicalObjections = (objectionEvents || [])
        .filter((e): e is CopilotEventRow & { event_data: { intent: string } } => {
          const intent = (e.event_data as { intent?: unknown } | null)?.intent;
          return typeof intent === 'string' && intent.startsWith('objecao');
        })
        .map((e) => e.event_data.intent)
        .slice(0, 5);

      const bundleCtx = topBundle ? {
        products: topBundle.bundle_products,
        lie: topBundle.lie_bundle,
        probability: topBundle.p_bundle,
        margin: topBundle.m_bundle,
      } : null;

      // For strategic plans, include second bundle for comparison
      const diagnosticData: DiagnosticData = { strategicObjective };
      if (planType === 'estrategico' && secondBundle) {
        diagnosticData.secondBundle = {
          products: secondBundle.bundle_products,
          lie: secondBundle.lie_bundle,
          probability: secondBundle.p_bundle,
          margin: secondBundle.m_bundle,
        };
      }

      const { data: aiPlan, error: aiError } = await supabase.functions.invoke<AiPlanResponse>('generate-tactical-plan', {
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
            salesHistoryStatus,
          },
          bundleContext: bundleCtx,
          diagnosticData,
          historicalObjections,
          planType,
        },
      });

      if (aiError) throw aiError;

      // Escrita via RPC-fronteira (#1037 + split de RLS): a posse (farmer_id) é re-resolvida
      // server-side de carteira_assignments e a RLS pós-split NEGA insert direto do client.
      // _expected_owner=ownerId faz a RPC ABORTAR se a carteira foi reatribuída durante a
      // geração da IA (race) em vez de gravar o dono stale; farmer_id/customer_user_id/status
      // são autoritativos do servidor (o client não controla mais a posse).
      const { error: rpcError } = await supabase.rpc('criar_plano_tatico' as never, {
        _customer_user_id: customerId,
        _expected_owner: ownerId,
        _payload: {
          bundle_recommendation_id: topBundle?.id || null,
          health_score: healthScore,
          churn_risk: churnRisk,
          mix_gap: mixGap,
          current_margin_pct: marginPct,
          cluster_avg_margin_pct: clusterMargin,
          expansion_potential: expansionPotential,
          strategic_objective: aiPlan?.strategic_objective || strategicObjective,
          customer_profile: customerProfile,
          plan_type: planType,
          top_bundle: topBundle ? topBundle.bundle_products : {},
          second_bundle: secondBundle ? secondBundle.bundle_products : {},
          bundle_lie: topBundle ? Number(topBundle.lie_bundle) : 0,
          bundle_probability: topBundle ? Number(topBundle.p_bundle) : 0,
          bundle_incremental_margin: topBundle ? Number(topBundle.m_bundle) : 0,
          best_individual_lie: 0,
          diagnostic_questions: aiPlan?.diagnostic_questions || [],
          implication_question: aiPlan?.implication_question || '',
          offer_transition: aiPlan?.offer_transition || '',
          probable_objections: aiPlan?.probable_objections || [],
          approach_strategy: aiPlan?.approach_strategy || '',
          approach_strategy_b: aiPlan?.approach_strategy_b || '',
          ltv_projection: aiPlan?.ltv_projection || null,
          expected_result: aiPlan?.expected_result || null,
          operational_risks: aiPlan?.operational_risks || [],
        },
      } as never);
      if (rpcError) throw rpcError;

      toast.success(`Plano ${planType === 'estrategico' ? 'estratégico' : 'essencial'} gerado com sucesso`);
      await loadPlans();
    } catch (err) {
      console.error('Error generating plan:', err);
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Erro ao gerar plano', { description: message });
    } finally {
      setGenerating(null);
    }
  }, [user, loadPlans]);

  // Get latest active plan for a customer (used by Copilot integration)
  const getActivePlan = useCallback(async (customerId: string): Promise<TacticalPlan | null> => {
    if (!effectiveUserId) return null;

    const owners = await fetchOwnerScope(effectiveUserId);
    const { data } = (await supabase
      .from('farmer_tactical_plans')
      .select('*')
      .in('farmer_id', owners)
      .eq('customer_user_id', customerId)
      .eq('status', 'gerado')
      .order('created_at', { ascending: false })
      .limit(1)) as unknown as { data: TacticalPlanRow[] | null };

    if (!data?.[0]) return null;

    const { data: profile } = (await supabase
      .from('profiles')
      .select('user_id, name')
      .eq('user_id', customerId)
      .single()) as unknown as { data: ProfileLite | null };

    const profileMap = new Map<string, string>([[customerId, profile?.name || 'Cliente']]);
    return parsePlan(data[0], profileMap);
  }, [effectiveUserId, fetchOwnerScope]);

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
      // Via RPC-fronteira (#1037 + split de RLS): gateia carteira_visivel_para(cliente do plano)
      // e a RLS pós-split nega UPDATE direto — fecha o #1 (qualquer staff com o UUID concluía
      // plano de carteira que não enxerga). completed_at/status são server-side.
      const { error } = await supabase.rpc('registrar_resultado_plano' as never, {
        _plan_id: planId,
        _plan_followed: result.planFollowed,
        _call_result: result.callResult,
        _actual_margin: result.actualMargin,
        _call_duration_seconds: result.callDurationSeconds,
        _objection_type: result.objectionType || null,
        _notes: result.notes || null,
      } as never);
      if (error) throw error;

      toast.success('Resultado registrado');
      await loadPlans();
    } catch (err) {
      console.error('Error recording result:', err);
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Erro ao registrar resultado', { description: message });
    }
  }, [loadPlans]);

  // Get effectiveness stats — efetividade da carteira PRÓPRIA por dono (effectiveUserId), NÃO inclui
  // coberturas (não inflar a métrica do gestor com a carteira do coberto; sob cobertura o plano
  // fica sob farmer_id=dono e conta pra efetividade do dono). Medir "por executor" exigiria uma
  // coluna generated_by — decisão adiada (YAGNI, 0 planos; ver docs/historico).
  const getEffectivenessStats = useCallback(async () => {
    if (!effectiveUserId) return null;

    const { data } = (await supabase
      .from('farmer_tactical_plans')
      .select('strategic_objective, plan_followed, actual_margin, call_duration_seconds, plan_type')
      .eq('farmer_id', effectiveUserId)
      .eq('status', 'concluido')) as unknown as { data: EffectivenessRow[] | null };

    if (!data?.length) return null;

    const byType: Record<string, { count: number; followed: number; totalMargin: number; totalTime: number }> = {};
    const byObjective: Record<string, { count: number; followed: number; totalMargin: number; totalTime: number }> = {};

    for (const d of data) {
      const obj = d.strategic_objective;
      const pt = d.plan_type || 'essencial';

      for (const [key] of [['obj_' + obj, byObjective], ['type_' + pt, byType]] as const) {
        const target = key.startsWith('obj_') ? byObjective : byType;
        const k = key.replace(/^(obj_|type_)/, '');
        if (!target[k]) target[k] = { count: 0, followed: 0, totalMargin: 0, totalTime: 0 };
        target[k].count++;
        if (d.plan_followed) target[k].followed++;
        target[k].totalMargin += Number(d.actual_margin || 0);
        target[k].totalTime += Number(d.call_duration_seconds || 0);
      }
    }

    const mapStats = (map: typeof byObjective) =>
      Object.entries(map).map(([key, stats]) => ({
        key,
        label: objectiveLabels[key] || key,
        count: stats.count,
        followRate: stats.count > 0 ? Math.round((stats.followed / stats.count) * 100) : 0,
        avgMargin: stats.count > 0 ? stats.totalMargin / stats.count : 0,
        profitPerHour: stats.totalTime > 0 ? (stats.totalMargin / stats.totalTime) * 3600 : 0,
      }));

    return { byObjective: mapStats(byObjective), byType: mapStats(byType) };
  }, [effectiveUserId]);

  return {
    plans,
    loading,
    generating,
    loadPlans,
    generatePlan,
    checkEfficiency,
    getActivePlan,
    recordResult,
    getEffectivenessStats,
  };
};
