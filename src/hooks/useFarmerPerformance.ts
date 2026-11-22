import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { proporcaoChurnBaixo } from '@/lib/scoring/churn';
import { META_FAMILIAS_MIX } from '@/lib/scoring/objective';
import { mediaAmplitudeMix, mediaGastoMedido, mediaPonderadaMedida } from '@/lib/scoring/salesBase';
import { fetchAllPages } from '@/lib/postgrest';
import { addDias, hojeSP } from '@/lib/time/sp-day';

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
  /** null = carteira sem comprador (mix sem base) — exibido como "—", fora da nota. */
  ipfMixExpansion: number | null;
  ipfLtvEvolution: number;
  ipfChurnReduction: number;
  ipfTotal: number;

  // Meta
  totalCalls: number;
  totalPlans: number;
  totalMargin: number;
  totalTimeSeconds: number;
}

interface PerformanceScoreRow {
  id: string;
  farmer_id: string;
  calculated_at: string;
  period_start: string;
  period_end: string;
  iee_ptpl_usage: number | string | null;
  iee_objective_adherence: number | string | null;
  iee_questions_usage: number | string | null;
  iee_bundle_offered: number | string | null;
  iee_post_call_registration: number | string | null;
  iee_total: number | string | null;
  ipf_incremental_margin: number | string | null;
  ipf_margin_per_hour: number | string | null;
  ipf_mix_expansion: number | string | null;
  ipf_ltv_evolution: number | string | null;
  ipf_churn_reduction: number | string | null;
  ipf_total: number | string | null;
  total_calls: number | string | null;
  total_plans: number | string | null;
  total_margin: number | string | null;
  total_time_seconds: number | string | null;
}

interface TacticalPlanRow {
  status: string | null;
  plan_followed: boolean | null;
  bundle_recommendation_id: string | null;
  actual_margin: number | string | null;
  call_duration_seconds: number | string | null;
}

interface FarmerCallRow {
  margin_generated: number | string | null;
  duration_seconds: number | string | null;
}

interface ClientScoreRow {
  customer_user_id: string | null;
  churn_risk: number | string | null;
  avg_monthly_spend_180d: number | string | null;
  health_score: number | string | null;
}

interface CopilotSessionRow {
  suggestions_shown: number | string | null;
  suggestions_used: number | string | null;
}

export const useFarmerPerformance = () => {
  const { user, role } = useAuth();
  const [scores, setScores] = useState<PerformanceScore[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);

  const parseScore = (d: PerformanceScoreRow, nameMap: Map<string, string>): PerformanceScore => ({
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
    ipfMixExpansion: d.ipf_mix_expansion == null ? null : Number(d.ipf_mix_expansion),
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
        .from('farmer_performance_scores')
        .select('*')
        .order('calculated_at', { ascending: false })
        .limit(100);

      if (farmerId) {
        query = query.eq('farmer_id', farmerId);
      }

      const { data } = (await query);
      if (!data) { setScores([]); return; }

      const farmerIds = [...new Set(data.map((d) => d.farmer_id))];
      const { data: profiles } = (await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', farmerIds));

      const nameMap = new Map<string, string>((profiles || []).map((p) => [p.user_id, p.name ?? 'Farmer']));
      setScores(data.map((d) => parseScore(d, nameMap)));
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
      // [GUARD money-path — dívida D1 latente, ver docs/historico/bugs-resolvidos.md §D1]
      // Sob cobertura de carteira (#980) o farmer_id DIVERGE entre as fontes: farmer_tactical_plans
      // e farmer_client_scores = DONO; farmer_calls e farmer_copilot_sessions = EXECUTOR. O IEE
      // (totalPlans/totalCalls) e o IPF (margem de plans + calls) misturariam dono×executor e o
      // score corrompido se propaga pros consumidores (Executive/IPF/Intelligence) → avaliação/comissão.
      // Enquanto a semântica não for decidida (generated_by ausente por YAGNI), precisão>recall:
      // sob cobertura NÃO persistir — degradar honesto. Fail-closed: leitura de cobertura que falha,
      // ou cálculo p/ TERCEIRO sem ser master (a RLS de carteira_coverage cega o viewer não-envolvido),
      // também suspendem (assumir o pior, nunca fabricar). Conduzido com /codex (challenge).
      const calculandoParaTerceiro = farmerId !== user.id;
      let suspenderPorCobertura = calculandoParaTerceiro && role !== 'master';
      if (!suspenderPorCobertura) {
        const [cov1, cov2] = await Promise.all([
          supabase.from('carteira_coverage').select('id, valid_until').eq('active', true).eq('covered_user_id', farmerId),
          supabase.from('carteira_coverage').select('id, valid_until').eq('active', true).eq('covering_user_id', farmerId),
        ]);
        // Cobertura EFETIVA = active E não-expirada — mesma definição de useCoverage/escopo-clientes
        // (active sem flip pós-prazo não pode fail-close pra sempre). nowIso no client, como o repo.
        const nowIso = new Date().toISOString();
        const vigente = (rows: { valid_until: string | null }[] | null) =>
          (rows ?? []).some((c) => !c.valid_until || c.valid_until > nowIso);
        suspenderPorCobertura = !!cov1.error || !!cov2.error || vigente(cov1.data) || vigente(cov2.data);
      }
      if (suspenderPorCobertura) {
        toast.warning('Índices de performance indisponíveis sob cobertura de carteira', {
          description: 'A métrica mistura dono e executor sob cobertura; cálculo suspenso até a semântica ser decidida (dívida D1).',
        });
        setCalculating(false);
        return;
      }

      const periodStart = new Date();
      periodStart.setDate(periodStart.getDate() - periodDays);
      const startStr = periodStart.toISOString();

      // Fetch tactical plans for the period
      const { data: plans } = (await supabase
        .from('farmer_tactical_plans')
        // Só o que o IPF usa. `select('*')` inclui as colunas de margem, fechadas para
        // authenticated (FU4-F, 20261015120100) — a query inteira cairia com 42501.
        .select('status, plan_followed, bundle_recommendation_id, actual_margin, call_duration_seconds')
        .eq('farmer_id', farmerId)
        .gte('created_at', startStr));

      // Fetch calls for the period
      const { data: calls } = (await supabase
        .from('farmer_calls')
        .select('*')
        .eq('farmer_id', farmerId)
        .gte('created_at', startStr));

      // Fetch client scores (current snapshot) — PAGINADO. A leitura single-shot de antes era cortada em
      // 1.000 linhas pelo PostgREST, sem erro, e as carteiras têm 14.177 e 2.842 (prod, psql-ro, 2026-11-21):
      // mix, LTV e churn saíam de um recorte arbitrário de 1.000. `fetchAllPages` LANÇA em página com erro →
      // o catch abaixo não persiste o score (fail-closed: carteira parcial não vira índice).
      const clientScores = await fetchAllPages(
        (de, ate) => supabase
          .from('farmer_client_scores')
          .select('id, customer_user_id, churn_risk, avg_monthly_spend_180d, health_score')
          .eq('farmer_id', farmerId)
          .order('id', { ascending: true })
          .range(de, ate),
        'farmer_client_scores/ipf',
      );

      // Amplitude de mix (20261121230000): famílias distintas por cliente em 12 meses — PAGINADO (o PostgREST
      // capa .rpc() em 1.000) e fail-closed como a carteira: página com erro lança e o score não é persistido.
      const familiasRows = await fetchAllPages(
        (de, ate) => supabase
          .rpc('familias_12m_clientes', { p_farmer_id: farmerId })
          .order('customer_user_id', { ascending: true })
          .range(de, ate),
        'familias_12m_clientes/ipf',
      );
      const familiasPorCliente = new Map(familiasRows.map((f) => [f.customer_user_id, f.familias_12m] as const));

      // Fetch copilot sessions
      const { data: copilotSessions } = (await supabase
        .from('farmer_copilot_sessions')
        .select('suggestions_shown, suggestions_used')
        .eq('farmer_id', farmerId)
        .gte('created_at', startStr));

      const plansArr: TacticalPlanRow[] = plans || [];
      const callsArr: FarmerCallRow[] = calls || [];
      const clientArr: ClientScoreRow[] = clientScores;
      const copilotArr: CopilotSessionRow[] = copilotSessions || [];

      const totalCalls = callsArr.length;
      const totalPlans = plansArr.length;
      const completedPlans = plansArr.filter((p) => p.status === 'concluido');
      const plansFollowed = completedPlans.filter((p) => p.plan_followed === true);

      // ── IEE Calculation ──────────────────────────────────────
      // 1. PTPL Usage: % of calls that had a plan generated before
      const callsWithPlan = totalCalls > 0 ? Math.min(100, (totalPlans / totalCalls) * 100) : 0;
      const ieePtplUsage = Math.round(callsWithPlan);

      // 2. Objective adherence: % of plans where objective was followed
      const ieeObjectiveAdherence = completedPlans.length > 0
        ? Math.round((plansFollowed.length / completedPlans.length) * 100)
        : 0;

      // 3. Questions usage: based on copilot suggestions used ratio
      const totalSugShown = copilotArr.reduce((s, c) => s + Number(c.suggestions_shown || 0), 0);
      const totalSugUsed = copilotArr.reduce((s, c) => s + Number(c.suggestions_used || 0), 0);
      const ieeQuestionsUsage = totalSugShown > 0
        ? Math.round(Math.min(100, (totalSugUsed / totalSugShown) * 100))
        : 50; // neutral if no data

      // 4. Bundle offered: % of plans with bundle_recommendation_id
      const plansWithBundle = plansArr.filter((p) => p.bundle_recommendation_id).length;
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
      const totalMargin = completedPlans.reduce((s, p) => s + Number(p.actual_margin || 0), 0);
      const totalTimeSeconds = completedPlans.reduce((s, p) => s + Number(p.call_duration_seconds || 0), 0);
      const totalCallMargin = callsArr.reduce((s, c) => s + Number(c.margin_generated || 0), 0);
      const totalCallTime = callsArr.reduce((s, c) => s + Number(c.duration_seconds || 0), 0);

      const combinedMargin = totalMargin + totalCallMargin;
      const combinedTime = totalTimeSeconds + totalCallTime;

      // 1. Incremental margin score (normalized to 0-100, target R$5000/month)
      const marginTarget = 5000;
      const ipfIncrementalMargin = Math.round(Math.min(100, (combinedMargin / marginTarget) * 100));

      // 2. Margin per hour (target R$100/h = 100 score)
      const marginPerHour = combinedTime > 0 ? (combinedMargin / combinedTime) * 3600 : 0;
      const ipfMarginPerHour = Math.round(Math.min(100, marginPerHour));

      // 3. Amplitude de mix: média de FAMÍLIAS distintas em 12 meses de quem comprou NA JANELA (meta 6, decisão
      // do founder 2026-11-21). Antes era a média de `category_count` (PRODUTOS distintos) sobre a carteira
      // inteira: 0,18 (3 pts) com 14.177 clientes, e 100 travado quando só sobre compradores. Ninguém na base
      // → null: o componente fica FORA da nota (renormalizada abaixo), nunca 0 fabricado.
      const { media: avgFamilias } = mediaAmplitudeMix(clientArr, familiasPorCliente);
      const ipfMixExpansion = avgFamilias == null ? null : Math.round(Math.min(100, (avgFamilias / META_FAMILIAS_MIX) * 100));

      // 4. LTV evolution: gasto mensal médio de quem tem gasto MEDIDO (target R$2000). O não medido (NULL desde
      // a calculate-scores v1.8 — quem nunca comprou) sai da base, como o churn desconhecido no item 5: o
      // `Number(x || 0)` o contava como R$ 0 e a carteira de 14.177 (286 medidos) pontuava 0 em vez de 9.
      // Ninguém medido → 0, mesma convenção do item 5 com `comRisco = 0`.
      const { media: avgSpend } = mediaGastoMedido(clientArr.map((c) => c.avg_monthly_spend_180d));
      const ipfLtvEvolution = avgSpend == null ? 0 : Math.round(Math.min(100, (avgSpend / 2000) * 100));

      // 5. Churn reduction: % de clientes com risco de churn conhecido E baixo (<30%).
      // A BASE é quem tem risco conhecido, não a carteira inteira. O `?? 100` do #1561 consertou
      // o numerador (churn REAL = 0 voltou a contar como bom), mas o desconhecido continuava no
      // denominador — então cada cliente sem score derrubava o índice do vendedor por lacuna de
      // DADO, não por desempenho. Numerador e denominador saem agora da mesma base filtrada.
      const { abaixo: lowChurnClients, comRisco } = proporcaoChurnBaixo(
        clientArr.map((c) => c.churn_risk),
        30,
      );
      const ipfChurnReduction = comRisco > 0
        ? Math.round((lowChurnClients / comRisco) * 100)
        : 0;

      // IPF Total (média ponderada RENORMALIZADA sobre os componentes medidos: mix null sai com o seu peso)
      const ipfTotalBruto = mediaPonderadaMedida([
        { valor: ipfIncrementalMargin, peso: 0.25 },
        { valor: ipfMarginPerHour, peso: 0.25 },
        { valor: ipfMixExpansion, peso: 0.20 },
        { valor: ipfLtvEvolution, peso: 0.15 },
        { valor: ipfChurnReduction, peso: 0.15 },
      ]);
      const ipfTotal = ipfTotalBruto == null ? null : Math.round(ipfTotalBruto);

      // Save score
      const scoreData = {
        farmer_id: farmerId,
        period_start: addDias(hojeSP(), -periodDays), // o dia de SP do início da janela (o UTC vira às 21h BRT)
        period_end: hojeSP(),
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
        .from('farmer_performance_scores')
        .insert(scoreData);

      toast.success('Índices calculados com sucesso');
      await loadScores(farmerId);
    } catch (err) {
      console.error('Error calculating scores:', err);
      const message = mensagemDeErro(err) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.';
      toast.error('Erro ao calcular índices', { description: message });
    } finally {
      setCalculating(false);
    }
  }, [user, role, loadScores]);

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
