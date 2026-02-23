import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface FarmerCall {
  id: string;
  farmer_id: string;
  customer_user_id: string;
  call_type: string;
  call_result: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  follow_up_duration_seconds: number;
  attempt_number: number;
  notes: string | null;
  linked_sales_order_id: string | null;
  revenue_generated: number;
  margin_generated: number;
  created_at: string;
}

interface FarmerConfig {
  hours_weekday: number;
  hours_friday: number;
  working_days_per_month: number;
}

interface FarmerLearningWeights {
  weight_recency: number;
  weight_frequency: number;
  weight_monetary: number;
  weight_margin: number;
  agenda_pct_risk: number;
  agenda_pct_recovery: number;
  agenda_pct_expansion: number;
  suggested_calls_per_day: number | null;
  suggested_portfolio_size: number | null;
  last_adjusted_at: string | null;
}

export interface FarmerMetrics {
  // Operational metrics
  avgCallDuration: number; // seconds
  avgFollowUpDuration: number; // seconds
  avgAttemptsToContact: number;
  contactRate: number; // percentage
  totalCalls: number;
  successfulContacts: number;

  // Financial metrics
  totalRevenue: number;
  totalMargin: number;
  marginPerHour: number;
  revenuePerCall: number;

  // Conversion rates by type
  conversionByType: {
    reativacao: number;
    cross_sell: number;
    up_sell: number;
    follow_up: number;
  };

  // Capacity calculations
  tTotal: number; // total time per contact in hours
  capacityPerDay: number; // max contacts per day
  avgDailyHours: number;

  // Portfolio optimization
  optimalFrequencyPerMonth: number;
  optimalClientsCount: number;
  currentActiveClients: number;
  portfolioRecommendation: 'expand' | 'reduce' | 'maintain';

  // Learning weights
  weights: FarmerLearningWeights;
  hasEnoughData: boolean; // 30+ days of data
  daysOfData: number;
}

const DEFAULT_CONFIG: FarmerConfig = {
  hours_weekday: 8.83, // 7:30-11:00 + 12:10-17:30
  hours_friday: 8.33, // 7:30-11:00 + 12:10-17:00
  working_days_per_month: 22,
};

const DEFAULT_WEIGHTS: FarmerLearningWeights = {
  weight_recency: 0.3,
  weight_frequency: 0.2,
  weight_monetary: 0.3,
  weight_margin: 0.2,
  agenda_pct_risk: 0.4,
  agenda_pct_recovery: 0.3,
  agenda_pct_expansion: 0.3,
  suggested_calls_per_day: null,
  suggested_portfolio_size: null,
  last_adjusted_at: null,
};

export const useFarmerMetrics = (farmerId?: string) => {
  const { user } = useAuth();
  const targetFarmerId = farmerId || user?.id;

  const [calls, setCalls] = useState<FarmerCall[]>([]);
  const [config, setConfig] = useState<FarmerConfig>(DEFAULT_CONFIG);
  const [weights, setWeights] = useState<FarmerLearningWeights>(DEFAULT_WEIGHTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!targetFarmerId) return;
    loadData();
  }, [targetFarmerId]);

  const loadData = async () => {
    if (!targetFarmerId) return;
    setLoading(true);
    try {
      // Load calls, config, and weights in parallel
      const [callsRes, configRes, weightsRes] = await Promise.all([
        supabase
          .from('farmer_calls')
          .select('*')
          .eq('farmer_id', targetFarmerId)
          .order('created_at', { ascending: false }),
        supabase
          .from('farmer_config')
          .select('*')
          .eq('farmer_id', targetFarmerId)
          .single(),
        supabase
          .from('farmer_learning_weights')
          .select('*')
          .eq('farmer_id', targetFarmerId)
          .single(),
      ]);

      if (callsRes.data) setCalls(callsRes.data as FarmerCall[]);
      if (configRes.data) {
        setConfig({
          hours_weekday: Number(configRes.data.hours_weekday),
          hours_friday: Number(configRes.data.hours_friday),
          working_days_per_month: configRes.data.working_days_per_month,
        });
      }
      if (weightsRes.data) {
        setWeights({
          weight_recency: Number(weightsRes.data.weight_recency),
          weight_frequency: Number(weightsRes.data.weight_frequency),
          weight_monetary: Number(weightsRes.data.weight_monetary),
          weight_margin: Number(weightsRes.data.weight_margin),
          agenda_pct_risk: Number(weightsRes.data.agenda_pct_risk),
          agenda_pct_recovery: Number(weightsRes.data.agenda_pct_recovery),
          agenda_pct_expansion: Number(weightsRes.data.agenda_pct_expansion),
          suggested_calls_per_day: weightsRes.data.suggested_calls_per_day,
          suggested_portfolio_size: weightsRes.data.suggested_portfolio_size,
          last_adjusted_at: weightsRes.data.last_adjusted_at,
        });
      }
    } catch (error) {
      console.error('Error loading farmer data:', error);
    } finally {
      setLoading(false);
    }
  };

  const metrics = useMemo<FarmerMetrics>(() => {
    if (calls.length === 0) {
      return {
        avgCallDuration: 0,
        avgFollowUpDuration: 0,
        avgAttemptsToContact: 0,
        contactRate: 0,
        totalCalls: 0,
        successfulContacts: 0,
        totalRevenue: 0,
        totalMargin: 0,
        marginPerHour: 0,
        revenuePerCall: 0,
        conversionByType: { reativacao: 0, cross_sell: 0, up_sell: 0, follow_up: 0 },
        tTotal: 0,
        capacityPerDay: 0,
        avgDailyHours: config.hours_weekday,
        optimalFrequencyPerMonth: 0,
        optimalClientsCount: 0,
        currentActiveClients: 0,
        portfolioRecommendation: 'maintain',
        weights,
        hasEnoughData: false,
        daysOfData: 0,
      };
    }

    // Days of data
    const sortedCalls = [...calls].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const firstCall = new Date(sortedCalls[0].created_at);
    const lastCall = new Date(sortedCalls[sortedCalls.length - 1].created_at);
    const daysOfData = Math.max(1, Math.ceil((lastCall.getTime() - firstCall.getTime()) / (1000 * 60 * 60 * 24)));

    // Basic metrics
    const totalCalls = calls.length;
    const successfulContacts = calls.filter(c => c.call_result === 'contato_sucesso').length;
    const contactRate = totalCalls > 0 ? (successfulContacts / totalCalls) * 100 : 0;

    const avgCallDuration = calls.reduce((sum, c) => sum + (c.duration_seconds || 0), 0) / totalCalls;
    const avgFollowUpDuration = calls.reduce((sum, c) => sum + (c.follow_up_duration_seconds || 0), 0) / totalCalls;

    // Average attempts to contact (group by customer + day)
    const customerAttempts = new Map<string, number[]>();
    calls.forEach(c => {
      const key = c.customer_user_id;
      if (!customerAttempts.has(key)) customerAttempts.set(key, []);
      customerAttempts.get(key)!.push(c.attempt_number);
    });
    const avgAttemptsToContact = customerAttempts.size > 0
      ? Array.from(customerAttempts.values()).reduce((sum, arr) => sum + Math.max(...arr), 0) / customerAttempts.size
      : 1;

    // Financial
    const totalRevenue = calls.reduce((sum, c) => sum + Number(c.revenue_generated || 0), 0);
    const totalMargin = calls.reduce((sum, c) => sum + Number(c.margin_generated || 0), 0);

    // Hours worked estimate
    const avgDailyHours = (config.hours_weekday * 4 + config.hours_friday) / 5;
    const totalHoursWorked = daysOfData * avgDailyHours * (5 / 7); // approximate working days
    const marginPerHour = totalHoursWorked > 0 ? totalMargin / totalHoursWorked : 0;
    const revenuePerCall = totalCalls > 0 ? totalRevenue / totalCalls : 0;

    // Conversion by type
    const typeGroups: Record<string, { total: number; converted: number }> = {
      reativacao: { total: 0, converted: 0 },
      cross_sell: { total: 0, converted: 0 },
      up_sell: { total: 0, converted: 0 },
      follow_up: { total: 0, converted: 0 },
    };
    calls.forEach(c => {
      if (typeGroups[c.call_type]) {
        typeGroups[c.call_type].total++;
        if (c.revenue_generated > 0) typeGroups[c.call_type].converted++;
      }
    });
    const conversionByType = {
      reativacao: typeGroups.reativacao.total > 0 ? (typeGroups.reativacao.converted / typeGroups.reativacao.total) * 100 : 0,
      cross_sell: typeGroups.cross_sell.total > 0 ? (typeGroups.cross_sell.converted / typeGroups.cross_sell.total) * 100 : 0,
      up_sell: typeGroups.up_sell.total > 0 ? (typeGroups.up_sell.converted / typeGroups.up_sell.total) * 100 : 0,
      follow_up: typeGroups.follow_up.total > 0 ? (typeGroups.follow_up.converted / typeGroups.follow_up.total) * 100 : 0,
    };

    // T_total = (T_call × N_attempts) + T_follow (in hours)
    const tTotal = ((avgCallDuration / 3600) * avgAttemptsToContact) + (avgFollowUpDuration / 3600);

    // Capacity_dia = Horas_úteis / T_total
    const capacityPerDay = tTotal > 0 ? avgDailyHours / tTotal : 0;

    // Optimal frequency (based on average repurchase interval)
    // Estimate from data: how often does each customer get called
    const uniqueClients = new Set(calls.map(c => c.customer_user_id)).size;
    const avgCallsPerClient = uniqueClients > 0 ? totalCalls / uniqueClients : 0;
    const optimalFrequencyPerMonth = daysOfData > 0
      ? (avgCallsPerClient / daysOfData) * 30
      : 2; // default 2x/month

    // Clientes_ótimos = (Capacidade_dia × Dias_úteis_mês) / Frequência_média_mensal
    const optimalClientsCount = optimalFrequencyPerMonth > 0
      ? Math.round((capacityPerDay * config.working_days_per_month) / optimalFrequencyPerMonth)
      : 0;

    // Portfolio recommendation
    let portfolioRecommendation: 'expand' | 'reduce' | 'maintain' = 'maintain';
    if (daysOfData >= 14 && uniqueClients > 0) {
      // Split data in half and compare margin/hour
      const midpoint = new Date(firstCall.getTime() + (lastCall.getTime() - firstCall.getTime()) / 2);
      const firstHalf = calls.filter(c => new Date(c.created_at) <= midpoint);
      const secondHalf = calls.filter(c => new Date(c.created_at) > midpoint);

      const firstHalfMargin = firstHalf.reduce((s, c) => s + Number(c.margin_generated || 0), 0);
      const secondHalfMargin = secondHalf.reduce((s, c) => s + Number(c.margin_generated || 0), 0);

      const firstHalfClients = new Set(firstHalf.map(c => c.customer_user_id)).size;
      const secondHalfClients = new Set(secondHalf.map(c => c.customer_user_id)).size;

      if (secondHalfClients > firstHalfClients && secondHalfMargin > firstHalfMargin * 1.1) {
        portfolioRecommendation = 'expand';
      } else if (secondHalfClients >= firstHalfClients && secondHalfMargin < firstHalfMargin * 0.9) {
        portfolioRecommendation = 'reduce';
      }
    }

    return {
      avgCallDuration,
      avgFollowUpDuration,
      avgAttemptsToContact,
      contactRate,
      totalCalls,
      successfulContacts,
      totalRevenue,
      totalMargin,
      marginPerHour,
      revenuePerCall,
      conversionByType,
      tTotal,
      capacityPerDay,
      avgDailyHours,
      optimalFrequencyPerMonth,
      optimalClientsCount,
      currentActiveClients: uniqueClients,
      portfolioRecommendation,
      weights,
      hasEnoughData: daysOfData >= 30,
      daysOfData,
    };
  }, [calls, config, weights]);

  // Auto-adjust weights after 30 days
  const adjustWeights = async () => {
    if (!targetFarmerId || !metrics.hasEnoughData) return;

    // Calculate optimal weights based on which call types produce the best margin/hour
    const typeMargins: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};

    calls.forEach(c => {
      if (!typeMargins[c.call_type]) {
        typeMargins[c.call_type] = 0;
        typeCounts[c.call_type] = 0;
      }
      typeMargins[c.call_type] += Number(c.margin_generated || 0);
      typeCounts[c.call_type]++;
    });

    const totalMarginAll = Object.values(typeMargins).reduce((s, v) => s + v, 0);

    // Adjust agenda proportions based on where margin comes from
    let newRisk = 0.4, newRecovery = 0.3, newExpansion = 0.3;
    if (totalMarginAll > 0) {
      const reativacaoShare = (typeMargins['reativacao'] || 0) / totalMarginAll;
      const followUpShare = (typeMargins['follow_up'] || 0) / totalMarginAll;
      const growthShare = ((typeMargins['cross_sell'] || 0) + (typeMargins['up_sell'] || 0)) / totalMarginAll;

      newRisk = Math.max(0.15, Math.min(0.6, reativacaoShare));
      newRecovery = Math.max(0.15, Math.min(0.6, followUpShare));
      newExpansion = Math.max(0.15, Math.min(0.6, growthShare));

      // Normalize to sum = 1
      const total = newRisk + newRecovery + newExpansion;
      newRisk /= total;
      newRecovery /= total;
      newExpansion /= total;
    }

    const newWeights = {
      farmer_id: targetFarmerId,
      agenda_pct_risk: Math.round(newRisk * 100) / 100,
      agenda_pct_recovery: Math.round(newRecovery * 100) / 100,
      agenda_pct_expansion: Math.round(newExpansion * 100) / 100,
      suggested_calls_per_day: Math.round(metrics.capacityPerDay),
      suggested_portfolio_size: metrics.optimalClientsCount,
      last_adjusted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await supabase
      .from('farmer_learning_weights')
      .upsert(newWeights, { onConflict: 'farmer_id' });

    await loadData();
  };

  return { metrics, calls, config, loading, reload: loadData, adjustWeights };
};
