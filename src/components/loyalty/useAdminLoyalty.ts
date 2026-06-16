// Hook de dados/estado do AdminLoyalty.
// Extraído verbatim de src/pages/AdminLoyalty.tsx (god-component split):
// state, redirect/load effects, loadData (3 queries + agregação por usuário),
// ajuste de pontos e derivados econômicos.
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { CustomerPoints, PointRecord, RedemptionRecord } from './types';

export function useAdminLoyalty() {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();

  const [customers, setCustomers] = useState<CustomerPoints[]>([]);
  const [allPoints, setAllPoints] = useState<PointRecord[]>([]);
  const [redemptions, setRedemptions] = useState<RedemptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerPoints | null>(null);
  const [customerHistory, setCustomerHistory] = useState<PointRecord[]>([]);

  // Adjust points dialog
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustUserId, setAdjustUserId] = useState('');
  const [adjustType, setAdjustType] = useState<'earn' | 'redeem'>('earn');
  const [adjustPoints, setAdjustPoints] = useState('');
  const [adjustDescription, setAdjustDescription] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      loadData();
    }
  }, [user, isStaff]);

  const loadData = async () => {
    try {
      const [pointsRes, profilesRes, redemptionsRes] = await Promise.all([
        supabase.from('loyalty_points').select('*').order('created_at', { ascending: false }),
        supabase.from('profiles').select('user_id, name'),
        supabase.from('loyalty_redemptions').select('*').order('created_at', { ascending: false }),
      ]);

      const points = (pointsRes.data || []) as PointRecord[];
      const profiles = profilesRes.data || [];
      const redData = (redemptionsRes.data || []) as RedemptionRecord[];
      setAllPoints(points);
      setRedemptions(redData);

      // Aggregate by user
      const userMap = new Map<string, CustomerPoints>();
      for (const p of points) {
        if (!userMap.has(p.user_id)) {
          const profile = profiles.find(pr => pr.user_id === p.user_id);
          userMap.set(p.user_id, {
            user_id: p.user_id,
            name: profile?.name || 'Desconhecido',
            total_earned: 0,
            total_redeemed: 0,
            balance: 0,
          });
        }
        const c = userMap.get(p.user_id)!;
        if (p.type === 'earn') {
          c.total_earned += p.points;
        } else {
          c.total_redeemed += Math.abs(p.points);
        }
        c.balance = c.total_earned - c.total_redeemed;
      }

      setCustomers(Array.from(userMap.values()).sort((a, b) => b.balance - a.balance));
    } catch (err) {
      console.error('Error loading loyalty data:', err);
    } finally {
      setLoading(false);
    }
  };

  const viewCustomerHistory = (customer: CustomerPoints) => {
    setSelectedCustomer(customer);
    setCustomerHistory(allPoints.filter(p => p.user_id === customer.user_id));
  };

  const openAdjust = (userId: string, type: 'earn' | 'redeem') => {
    setAdjustUserId(userId);
    setAdjustType(type);
    setAdjustOpen(true);
  };

  const handleAdjustPoints = async () => {
    if (!adjustPoints || !adjustUserId) return;
    setAdjusting(true);

    try {
      const pts = parseInt(adjustPoints);
      if (isNaN(pts) || pts <= 0) {
        toast.error('Pontos inválidos');
        return;
      }

      const { error } = await supabase.from('loyalty_points').insert({
        user_id: adjustUserId,
        points: adjustType === 'redeem' ? -pts : pts,
        type: adjustType,
        description: adjustDescription || (adjustType === 'earn' ? 'Pontos adicionados pelo admin' : 'Resgate aprovado pelo admin'),
      });

      if (error) throw error;

      toast.success(adjustType === 'earn' ? 'Pontos adicionados!' : 'Resgate aprovado!');
      setAdjustOpen(false);
      setAdjustPoints('');
      setAdjustDescription('');
      loadData();
    } catch (err) {
      console.error('Error adjusting points:', err);
      toast.error('Erro ao ajustar pontos');
    } finally {
      setAdjusting(false);
    }
  };

  const totalPointsCirculating = customers.reduce((s, c) => s + c.balance, 0);
  const totalEarned = customers.reduce((s, c) => s + c.total_earned, 0);
  const totalRedeemed = customers.reduce((s, c) => s + c.total_redeemed, 0);

  // Estimated liability: 1 pt ≈ R$0.01 (conservative estimate based on typical reward catalog)
  const estimatedLiability = totalPointsCirculating * 0.01;
  const redemptionRate = totalEarned > 0 ? ((totalRedeemed / totalEarned) * 100).toFixed(1) : '0';

  // Top redeemed rewards
  const rewardCounts = new Map<string, number>();
  for (const r of redemptions) {
    rewardCounts.set(r.reward_name, (rewardCounts.get(r.reward_name) || 0) + 1);
  }
  const topRewards = Array.from(rewardCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Top balance users (already sorted)
  const topBalanceUsers = customers.slice(0, 5);

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return {
    authLoading,
    loading,
    search,
    setSearch,
    selectedCustomer,
    setSelectedCustomer,
    customerHistory,
    viewCustomerHistory,
    openAdjust,
    totalPointsCirculating,
    totalEarned,
    totalRedeemed,
    estimatedLiability,
    redemptionRate,
    topRewards,
    topBalanceUsers,
    filtered,
    // adjust dialog
    adjustOpen,
    setAdjustOpen,
    adjustType,
    adjustPoints,
    setAdjustPoints,
    adjustDescription,
    setAdjustDescription,
    adjusting,
    handleAdjustPoints,
  };
}
