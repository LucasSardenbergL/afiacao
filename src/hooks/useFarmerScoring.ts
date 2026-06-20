import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import type { Tables } from '@/integrations/supabase/types';
import { custoCanonico } from '@/lib/custo/custoCanonico';

type AlgorithmConfigRow = Pick<Tables<'farmer_algorithm_config'>, 'key' | 'value'>;
type ProductCostRow = Pick<Tables<'product_costs'>, 'product_id' | 'cost_price' | 'cost_final'>;
type FarmerCallRow = Pick<
  Tables<'farmer_calls'>,
  'customer_user_id' | 'call_result' | 'is_whatsapp' | 'whatsapp_replied' | 'created_at'
>;
type ProfileRow = Pick<Tables<'profiles'>, 'user_id' | 'name' | 'phone'>;
type SalesOrderRow = Pick<
  Tables<'sales_orders'>,
  'id' | 'customer_user_id' | 'items' | 'total' | 'created_at' | 'status'
>;

interface SalesOrderItem {
  product_id?: string;
  quantity?: number | string;
  unit_price?: number | string;
}

// ─── Types ───────────────────────────────────────────────────────────
export interface AlgorithmConfig {
  k1: number; k2: number; cat_target: number;
  health_w_rf: number; health_w_m: number; health_w_g: number;
  health_w_x: number; health_w_s: number;
  priority_w_churn: number; priority_w_recover: number;
  priority_w_expansion: number; priority_w_eff: number;
  agenda_pct_risco: number; agenda_pct_expansao: number;
  agenda_pct_followup: number; sla_contact_days: number;
}

export interface ClientScore {
  customer_user_id: string;
  customer_name: string;
  customer_phone: string | null;
  // Health
  rf: number; m: number; g: number; x: number; s: number;
  healthScore: number;
  healthClass: 'saudavel' | 'estavel' | 'atencao' | 'critico';
  // Priority
  churnRisk: number; recoverScore: number;
  expansionScore: number; effScore: number;
  priorityScore: number;
  // Raw
  daysSinceLastPurchase: number;
  avgRepurchaseInterval: number;
  avgMonthlySpend180d: number;
  grossMarginPct: number;
  categoryCount: number;
  answerRate60d: number;
  whatsappReplyRate60d: number;
  revenuePotential: number;
}

export interface AgendaItem {
  customer_user_id: string;
  customer_name: string;
  priorityScore: number;
  agendaType: 'risco' | 'expansao' | 'follow_up';
  healthClass: string;
}

const DEFAULT_CONFIG: AlgorithmConfig = {
  k1: 1.0, k2: 1.0, cat_target: 5,
  health_w_rf: 0.35, health_w_m: 0.20, health_w_g: 0.15,
  health_w_x: 0.15, health_w_s: 0.15,
  priority_w_churn: 0.40, priority_w_recover: 0.30,
  priority_w_expansion: 0.20, priority_w_eff: 0.10,
  agenda_pct_risco: 0.50, agenda_pct_expansao: 0.30,
  agenda_pct_followup: 0.20, sla_contact_days: 14,
};

// ─── Helpers ─────────────────────────────────────────────────────────
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function classifyHealth(score: number): 'saudavel' | 'estavel' | 'atencao' | 'critico' {
  if (score >= 80) return 'saudavel';
  if (score >= 60) return 'estavel';
  if (score >= 40) return 'atencao';
  return 'critico';
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Main Hook ───────────────────────────────────────────────────────
export const useFarmerScoring = (farmerId?: string) => {
  // Lente "Ver como": id efetivo = ALVO na lente (lê/exibe a agenda dele), próprio usuário fora.
  const { effectiveUserId } = useImpersonation();
  const targetFarmerId = farmerId || effectiveUserId;

  const [config, setConfig] = useState<AlgorithmConfig>(DEFAULT_CONFIG);
  const [clientScores, setClientScores] = useState<ClientScore[]>([]);
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);

  // Load algorithm config
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('farmer_algorithm_config').select('key, value');
      const rows = (data ?? []) as AlgorithmConfigRow[];
      if (rows.length > 0) {
        const map: Record<string, number> = {};
        rows.forEach((r) => { map[r.key] = Number(r.value); });
        setConfig(prev => ({ ...prev, ...map } as AlgorithmConfig));
      }
    })();
  }, []);

  // Calculate scores for all clients
  const calculateScores = useCallback(async () => {
    if (!targetFarmerId) {
      setCalculating(false);
      setLoading(false);
      return;
    }
    setCalculating(true);

    try {
      // 1. Load all customers with sales orders
      const { data: salesOrdersData } = await supabase
        .from('sales_orders')
        .select('id, customer_user_id, items, total, created_at, status')
        .in('status', ['confirmado', 'faturado', 'entregue']);
      const salesOrders = (salesOrdersData ?? []) as SalesOrderRow[];

      if (salesOrders.length === 0) {
        setClientScores([]);
        setAgenda([]);
        setCalculating(false);
        setLoading(false);
        return;
      }

      // Fornecedores fora da carteira: clientes marcados p/ exclusão saem do universo ANTES do cálculo.
      const flaggeds = new Set<string>();
      for (let fp = 0; ; fp++) {
        const { data: fPage, error: fErr } = await supabase
          .from('cliente_classificacao')
          .select('user_id')
          .eq('excluir_da_carteira', true)
          .range(fp * 1000, fp * 1000 + 999);
        // FAIL-CLOSED (Codex P1): money-path. Se a leitura dos fornecedores excluídos falhar,
        // aborta o recálculo/upsert (não grava score de fornecedor); mantém o último estado bom.
        if (fErr) {
          console.warn('[useFarmerScoring] erro ao ler fornecedores excluídos, abortando:', fErr.message);
          setCalculating(false);
          setLoading(false);
          return;
        }
        if (!fPage || fPage.length === 0) break;
        for (const r of fPage) flaggeds.add(r.user_id);
        if (fPage.length < 1000) break;
      }

      // 2. Load product costs for margin calculation
      const { data: productCostsData } = await supabase
        .from('product_costs')
        .select('product_id, cost_final, cost_price');
      const productCosts = (productCostsData ?? []) as ProductCostRow[];
      const costMap = new Map<string, number>();
      // Custo canônico = cost_final (proxy-aware); cost_price agora é nullable (só custo real).
      // Number(null)===0 inflava a margem (ausente≠zero) — excluir SKU sem custo, não fabricar 0.
      productCosts.forEach((pc) => {
        const c = custoCanonico(pc);
        if (c != null) costMap.set(pc.product_id, c);
      });

      // 3. Load farmer calls for contact rates
      const { data: callsData } = await supabase
        .from('farmer_calls')
        .select('customer_user_id, call_result, is_whatsapp, whatsapp_replied, created_at')
        .eq('farmer_id', targetFarmerId);
      const calls = (callsData ?? []) as FarmerCallRow[];

      // 4. Load customer profiles
      const customerIds = [...new Set(salesOrders.map((o) => o.customer_user_id))];
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('user_id, name, phone')
        .in('user_id', customerIds);
      const profiles = (profilesData ?? []) as ProfileRow[];
      const profileMap = new Map<string, { name: string; phone: string | null }>();
      profiles.forEach((p) => profileMap.set(p.user_id, { name: p.name, phone: p.phone }));

      // 5. Aggregate per-customer data
      const now = Date.now();
      const sixMonthsAgo = now - 180 * 24 * 60 * 60 * 1000;
      const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;

      interface CustomerData {
        orderDates: number[];
        totalSpend: number;
        spend180d: number;
        totalRevenue: number;
        totalCost: number;
        categories: Set<string>;
        calls60d: number;
        contactSuccess60d: number;
        whatsappCalls60d: number;
        whatsappReplied60d: number;
        lastContactDate: number;
      }

      const customerMap = new Map<string, CustomerData>();

      for (const order of salesOrders) {
        const cid = order.customer_user_id;
        if (flaggeds.has(cid)) continue;
        if (!customerMap.has(cid)) {
          customerMap.set(cid, {
            orderDates: [], totalSpend: 0, spend180d: 0,
            totalRevenue: 0, totalCost: 0, categories: new Set(),
            calls60d: 0, contactSuccess60d: 0,
            whatsappCalls60d: 0, whatsappReplied60d: 0,
            lastContactDate: 0,
          });
        }
        const cd = customerMap.get(cid)!;
        const orderTime = new Date(order.created_at).getTime();
        cd.orderDates.push(orderTime);
        cd.totalSpend += Number(order.total || 0);
        if (orderTime >= sixMonthsAgo) cd.spend180d += Number(order.total || 0);

        // Parse items for categories and margin
        const items: SalesOrderItem[] = Array.isArray(order.items)
          ? (order.items as unknown as SalesOrderItem[])
          : [];
        for (const item of items) {
          if (item.product_id) {
            cd.categories.add(item.product_id);
            const qty = Number(item.quantity || 1);
            const price = Number(item.unit_price || 0);
            const cost = costMap.get(item.product_id) || 0;
            cd.totalRevenue += price * qty;
            cd.totalCost += cost * qty;
          }
        }
      }

      // Aggregate call data
      for (const call of calls) {
        const cid = call.customer_user_id;
        if (!cid) continue;
        const cd = customerMap.get(cid);
        if (!cd) continue;
        const callTime = new Date(call.created_at).getTime();
        if (callTime > cd.lastContactDate) cd.lastContactDate = callTime;
        if (callTime >= sixtyDaysAgo) {
          cd.calls60d++;
          if (call.call_result === 'contato_sucesso') cd.contactSuccess60d++;
          if (call.is_whatsapp) {
            cd.whatsappCalls60d++;
            if (call.whatsapp_replied) cd.whatsappReplied60d++;
          }
        }
      }

      // 6. Compute population-level stats for normalization
      const allMonthlySpends: number[] = [];
      const allMargins: number[] = [];

      customerMap.forEach(cd => {
        const months = Math.max(1, 6); // 180d
        allMonthlySpends.push(cd.spend180d / months);
        if (cd.totalRevenue > 0) {
          allMargins.push((cd.totalRevenue - cd.totalCost) / cd.totalRevenue);
        }
      });

      const p95MonthlySpend = percentile(allMonthlySpends, 95) || 1;
      const p10Margin = percentile(allMargins, 10);
      const p90Margin = percentile(allMargins, 90);
      const marginRange = Math.max(p90Margin - p10Margin, 0.01);

      // 7. Calculate scores per client
      const scores: ClientScore[] = [];

      customerMap.forEach((cd, cid) => {
        const profile = profileMap.get(cid);
        if (!profile) return;

        // Sort order dates
        cd.orderDates.sort((a, b) => a - b);
        const lastPurchase = cd.orderDates[cd.orderDates.length - 1];
        const D = Math.max(0, Math.floor((now - lastPurchase) / (1000 * 60 * 60 * 24)));

        // Average repurchase interval
        let I = 30; // default
        if (cd.orderDates.length >= 2) {
          const intervals: number[] = [];
          for (let i = 1; i < cd.orderDates.length; i++) {
            intervals.push((cd.orderDates[i] - cd.orderDates[i - 1]) / (1000 * 60 * 60 * 24));
          }
          I = intervals.reduce((s, v) => s + v, 0) / intervals.length;
        }

        // RF = exp(-k2 * max((D/max(I,1)) - 1, 0))
        const rfRatio = Math.max((D / Math.max(I, 1)) - 1, 0);
        const rf = Math.exp(-config.k2 * rfRatio);

        // M = log(1 + AvgMonthlySpend_180d) / log(1 + P95MonthlySpend)
        const avgMonthly = cd.spend180d / 6;
        const m = clamp(Math.log(1 + avgMonthly) / Math.log(1 + p95MonthlySpend), 0, 1);

        // G = clamp((GrossMarginClient - P10Margin) / (P90Margin - P10Margin), 0, 1)
        const clientMargin = cd.totalRevenue > 0 ? (cd.totalRevenue - cd.totalCost) / cd.totalRevenue : 0;
        const g = clamp((clientMargin - p10Margin) / marginRange, 0, 1);

        // X = clamp(CatCount / CatTarget, 0, 1)
        const x = clamp(cd.categories.size / config.cat_target, 0, 1);

        // S = 0.7*AnswerRate_60d + 0.3*WhatsAppReplyRate_60d
        const answerRate = cd.calls60d > 0 ? cd.contactSuccess60d / cd.calls60d : 0;
        const whatsappRate = cd.whatsappCalls60d > 0 ? cd.whatsappReplied60d / cd.whatsappCalls60d : 0;
        const s = 0.7 * answerRate + 0.3 * whatsappRate;

        // Health = 100 * (0.35*RF + 0.20*M + 0.15*G + 0.15*X + 0.15*S)
        const healthScore = 100 * (
          config.health_w_rf * rf +
          config.health_w_m * m +
          config.health_w_g * g +
          config.health_w_x * x +
          config.health_w_s * s
        );

        // ChurnRisk = 100 * (1 - exp(-k1 * max((D/max(I,1)) - 1, 0)))
        const churnRisk = 100 * (1 - Math.exp(-config.k1 * rfRatio));

        // RecoverScore: based on delayed potential revenue
        const expectedMonthly = avgMonthly;
        const delayedMonths = Math.max(0, (D - I) / 30);
        const recoverScore = clamp(delayedMonths * expectedMonthly / Math.max(p95MonthlySpend * 6, 1) * 100, 0, 100);

        // Expansion: based on category gap + monetary potential
        const mixGap = 1 - (cd.categories.size / Math.max(config.cat_target, 1));
        const expansionScore = clamp((mixGap * 0.6 + m * 0.4) * 100, 0, 100);

        // Efficiency: SLA compliance
        const daysSinceContact = cd.lastContactDate > 0
          ? Math.floor((now - cd.lastContactDate) / (1000 * 60 * 60 * 24))
          : 999;
        const effScore = clamp((1 - Math.min(daysSinceContact / config.sla_contact_days, 2) / 2) * 100, 0, 100);

        // Priority = weighted sum
        const priorityScore =
          config.priority_w_churn * churnRisk +
          config.priority_w_recover * recoverScore +
          config.priority_w_expansion * expansionScore +
          config.priority_w_eff * effScore;

        scores.push({
          customer_user_id: cid,
          customer_name: profile.name,
          customer_phone: profile.phone,
          rf, m, g, x, s,
          healthScore: Math.round(healthScore * 10) / 10,
          healthClass: classifyHealth(healthScore),
          churnRisk: Math.round(churnRisk * 10) / 10,
          recoverScore: Math.round(recoverScore * 10) / 10,
          expansionScore: Math.round(expansionScore * 10) / 10,
          effScore: Math.round(effScore * 10) / 10,
          priorityScore: Math.round(priorityScore * 10) / 10,
          daysSinceLastPurchase: D,
          avgRepurchaseInterval: Math.round(I * 10) / 10,
          avgMonthlySpend180d: Math.round(avgMonthly * 100) / 100,
          grossMarginPct: Math.round(clientMargin * 1000) / 10,
          categoryCount: cd.categories.size,
          answerRate60d: Math.round(answerRate * 1000) / 10,
          whatsappReplyRate60d: Math.round(whatsappRate * 1000) / 10,
          revenuePotential: Math.round(expectedMonthly * delayedMonths * 100) / 100,
        });
      });

      // Sort by priority descending
      scores.sort((a, b) => b.priorityScore - a.priorityScore);
      setClientScores(scores);

      // 8. Generate agenda with quotas
      const totalSlots = Math.min(scores.length, 20); // max 20 per day
      const riscoSlots = Math.round(totalSlots * config.agenda_pct_risco);
      const expansaoSlots = Math.round(totalSlots * config.agenda_pct_expansao);
      const followUpSlots = totalSlots - riscoSlots - expansaoSlots;

      const agendaItems: AgendaItem[] = [];
      const used = new Set<string>();

      // Risco: highest churn risk
      const riscoSorted = [...scores].sort((a, b) => b.churnRisk - a.churnRisk);
      for (const s of riscoSorted) {
        if (agendaItems.filter(a => a.agendaType === 'risco').length >= riscoSlots) break;
        if (used.has(s.customer_user_id)) continue;
        used.add(s.customer_user_id);
        agendaItems.push({
          customer_user_id: s.customer_user_id,
          customer_name: s.customer_name,
          priorityScore: s.priorityScore,
          agendaType: 'risco',
          healthClass: s.healthClass,
        });
      }

      // Expansão: highest expansion score
      const expSorted = [...scores].sort((a, b) => b.expansionScore - a.expansionScore);
      for (const s of expSorted) {
        if (agendaItems.filter(a => a.agendaType === 'expansao').length >= expansaoSlots) break;
        if (used.has(s.customer_user_id)) continue;
        used.add(s.customer_user_id);
        agendaItems.push({
          customer_user_id: s.customer_user_id,
          customer_name: s.customer_name,
          priorityScore: s.priorityScore,
          agendaType: 'expansao',
          healthClass: s.healthClass,
        });
      }

      // Follow-up: remaining by priority
      for (const s of scores) {
        if (agendaItems.filter(a => a.agendaType === 'follow_up').length >= followUpSlots) break;
        if (used.has(s.customer_user_id)) continue;
        used.add(s.customer_user_id);
        agendaItems.push({
          customer_user_id: s.customer_user_id,
          customer_name: s.customer_name,
          priorityScore: s.priorityScore,
          agendaType: 'follow_up',
          healthClass: s.healthClass,
        });
      }

      setAgenda(agendaItems);

      // 9. Persistência: NENHUMA escrita client-side — este hook é DISPLAY-ONLY by design.
      // Writer autoritativo de farmer_client_scores = edge `calculate-scores` (cron diário
      // `daily-calculate-scores`, service_role): resolve farmer_id = dono via carteira_assignments
      // (Opção A, migration 20260524170000) e NÃO reconcilia farmer_id no UPDATE (migration 20260524180000).
      // ⚠️ NÃO reintroduzir upsert aqui: o universo é company-wide (sales_orders, sem filtro de dono) e
      // gravaria farmer_id = targetFarmerId; sob RLS um gestor/master (pode_ver_carteira_completa) flipa a
      // posse de TODA a base e o cron não desfaz. Detalhe: docs/historico/bugs-resolvidos.md.

    } catch (error) {
      console.error('Error calculating scores:', error);
    } finally {
      setCalculating(false);
      setLoading(false);
    }
  }, [targetFarmerId, config]);

  useEffect(() => {
    if (targetFarmerId) calculateScores();
  }, [targetFarmerId]);

  // Summary stats
  const summary = useMemo(() => {
    if (clientScores.length === 0) return {
      totalClients: 0, avgHealth: 0, avgPriority: 0,
      saudavel: 0, estavel: 0, atencao: 0, critico: 0,
    };
    const avgHealth = clientScores.reduce((s, c) => s + c.healthScore, 0) / clientScores.length;
    const avgPriority = clientScores.reduce((s, c) => s + c.priorityScore, 0) / clientScores.length;
    return {
      totalClients: clientScores.length,
      avgHealth: Math.round(avgHealth * 10) / 10,
      avgPriority: Math.round(avgPriority * 10) / 10,
      saudavel: clientScores.filter(c => c.healthClass === 'saudavel').length,
      estavel: clientScores.filter(c => c.healthClass === 'estavel').length,
      atencao: clientScores.filter(c => c.healthClass === 'atencao').length,
      critico: clientScores.filter(c => c.healthClass === 'critico').length,
    };
  }, [clientScores]);

  return {
    config, clientScores, agenda, summary,
    loading, calculating,
    recalculate: calculateScores,
  };
};
