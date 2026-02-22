import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface GamificationData {
  consistency_score: number;
  organization_score: number;
  education_score: number;
  referral_score: number;
  efficiency_score: number;
  total_score: number;
  level: number;
  level_name: string;
  tool_health_index: number;
}

const LEVEL_THRESHOLDS = [
  { level: 1, name: 'Operacional', min: 0 },
  { level: 2, name: 'Organizado', min: 20 },
  { level: 3, name: 'Profissional', min: 40 },
  { level: 4, name: 'Elite Técnica', min: 65 },
  { level: 5, name: 'Parceiro Estratégico', min: 85 },
];

export function getLevelInfo(score: number) {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (score >= LEVEL_THRESHOLDS[i].min) {
      const current = LEVEL_THRESHOLDS[i];
      const next = LEVEL_THRESHOLDS[i + 1];
      return {
        ...current,
        nextLevel: next || null,
        progressToNext: next
          ? ((score - current.min) / (next.min - current.min)) * 100
          : 100,
      };
    }
  }
  return { ...LEVEL_THRESHOLDS[0], nextLevel: LEVEL_THRESHOLDS[1], progressToNext: 0 };
}

export function useGamificationScore(userId?: string) {
  const { user } = useAuth();
  const targetUserId = userId || user?.id;
  const [data, setData] = useState<GamificationData | null>(null);
  const [loading, setLoading] = useState(true);

  const computeScore = useCallback(async () => {
    if (!targetUserId) { setLoading(false); return; }

    try {
      // Fetch all needed data in parallel
      const [toolsRes, qualityRes, trainingRes, referralsRes, ordersRes] = await Promise.all([
        supabase.from('user_tools').select('id, next_sharpening_due, last_sharpened_at, sharpening_interval_days').eq('user_id', targetUserId),
        supabase.from('sending_quality_logs').select('score').eq('user_id', targetUserId),
        supabase.from('training_completions').select('passed').eq('user_id', targetUserId),
        supabase.from('referrals').select('status').eq('referrer_id', targetUserId),
        supabase.from('orders').select('status, created_at').eq('user_id', targetUserId),
      ]);

      const tools = toolsRes.data || [];
      const qualityLogs = qualityRes.data || [];
      const trainings = trainingRes.data || [];
      const referrals = referralsRes.data || [];
      const orders = ordersRes.data || [];

      // A. Consistency: % of tools within ideal maintenance window
      let consistency = 0;
      if (tools.length > 0) {
        const now = new Date();
        const toolsInWindow = tools.filter(t => {
          if (!t.next_sharpening_due) return true; // no due date = ok
          return new Date(t.next_sharpening_due) >= now;
        });
        consistency = (toolsInWindow.length / tools.length) * 100;
      } else {
        consistency = 50; // neutral if no tools
      }

      // B. Organization: average sending quality score (0-100)
      let organization = 0;
      if (qualityLogs.length > 0) {
        const avg = qualityLogs.reduce((sum, l) => sum + l.score, 0) / qualityLogs.length;
        organization = avg; // score is 0-100
      } else {
        organization = 50; // neutral
      }

      // C. Education: % of trainings passed
      let education = 0;
      if (trainings.length > 0) {
        const passed = trainings.filter(t => t.passed).length;
        education = (passed / trainings.length) * 100;
      }

      // D. Referrals: converted referrals (max 100 for 5+ converted)
      const convertedReferrals = referrals.filter(r => r.status === 'converted').length;
      const referralScore = Math.min(convertedReferrals * 20, 100);

      // E. Efficiency: ratio of non-emergency orders
      let efficiency = 50;
      if (orders.length > 0) {
        const normalOrders = orders.filter(o => o.status !== 'emergencia').length;
        efficiency = (normalOrders / orders.length) * 100;
      }

      // Tool Health Index
      let toolHealth = 0;
      if (tools.length > 0) {
        const now = new Date();
        const healthy = tools.filter(t => {
          if (!t.next_sharpening_due) return true;
          return new Date(t.next_sharpening_due) >= now;
        });
        toolHealth = (healthy.length / tools.length) * 100;
      }

      // Weighted total
      const total = 
        (consistency * 0.40) +
        (organization * 0.20) +
        (education * 0.15) +
        (referralScore * 0.15) +
        (efficiency * 0.10);

      const levelInfo = getLevelInfo(total);

      const scoreData: GamificationData = {
        consistency_score: Math.round(consistency * 10) / 10,
        organization_score: Math.round(organization * 10) / 10,
        education_score: Math.round(education * 10) / 10,
        referral_score: Math.round(referralScore * 10) / 10,
        efficiency_score: Math.round(efficiency * 10) / 10,
        total_score: Math.round(total * 10) / 10,
        level: levelInfo.level,
        level_name: levelInfo.name,
        tool_health_index: Math.round(toolHealth * 10) / 10,
      };

      setData(scoreData);

      // Upsert to DB for ranking
      await supabase.from('gamification_scores').upsert({
        user_id: targetUserId,
        ...scoreData,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    } catch (err) {
      console.error('Error computing gamification score:', err);
    } finally {
      setLoading(false);
    }
  }, [targetUserId]);

  useEffect(() => {
    computeScore();
  }, [computeScore]);

  return { data, loading, refetch: computeScore };
}
