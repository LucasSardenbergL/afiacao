import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';

export interface RecommendationItem {
  product_id: string;
  codigo: string;
  descricao: string;
  price: number;
  margin: number;
  probability: number;
  eip: number;
  score_final: number;
  recommendation_type: string;
  explanation_text: string;
  explanation_key: string;
  estoque: number;
  _admin?: {
    cost_final: number;
    cost_source: string;
    cost_confidence: number;
    assoc_score: number;
    sim_score: number;
    ctx_score: number;
    penalties: number;
    familia: string | null;
    eiltv: number;
  };
}

export interface RecommendationResult {
  recommendations: RecommendationItem[];
  meta: {
    total_candidates: number;
    mode: 'profit' | 'ltv';
    weights: { wA: number; wP: number; wS: number; wC: number };
    top_n: number;
  };
}

export function useRecommendationEngine() {
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const [result, setResult] = useState<RecommendationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRecommendations = useCallback(async (
    customerId: string,
    basketProductIds: string[] = []
  ) => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('recommend', {
        body: {
          action: 'recommend',
          customer_id: customerId,
          basket_product_ids: basketProductIds,
        },
      });

      if (fnError) throw fnError;
      if (!data?.success) throw new Error(data?.error || 'Erro desconhecido');

      const res = data.data as RecommendationResult;

      // Strip admin fields for non-admin users
      if (!isAdmin) {
        res.recommendations = res.recommendations.map(r => {
          const { _admin, ...rest } = r;
          return rest;
        });
      }

      setResult(res);
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao buscar recomendações';
      setError(msg);
      console.error('[RecommendationEngine]', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [user?.id, isAdmin]);

  const logAccept = useCallback(async (
    customerId: string,
    productId: string,
    quantityAccepted: number = 1,
    salesOrderId?: string
  ) => {
    await supabase.functions.invoke('recommend', {
      body: {
        action: 'log_accept',
        customer_id: customerId,
        product_id: productId,
        quantity_accepted: quantityAccepted,
        sales_order_id: salesOrderId,
      },
    });
  }, []);

  const logReject = useCallback(async (customerId: string, productId: string) => {
    await supabase.functions.invoke('recommend', {
      body: {
        action: 'log_reject',
        customer_id: customerId,
        product_id: productId,
      },
    });
  }, []);

  return {
    result,
    recommendations: result?.recommendations || [],
    meta: result?.meta || null,
    loading,
    error,
    fetchRecommendations,
    logAccept,
    logReject,
  };
}
