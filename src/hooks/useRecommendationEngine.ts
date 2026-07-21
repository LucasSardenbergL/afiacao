import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface RecommendationItem {
  product_id: string;
  codigo: string;
  descricao: string;
  price: number;
  // FU4-F/3: `null` quando o servidor não concedeu custo (private.cap_custo_ler). Chave PRESENTE
  // com null — degradação honesta: "não posso mostrar", não "vale zero". `fmt()` já rende "—".
  margin: number | null;
  probability: number;
  eip: number | null;
  recommendation_type: string;
  explanation_text: string;
  explanation_key: string;
  estoque: number;
  // Bloco inteiro AUSENTE sem cap_custo_ler — a decisão é do servidor, não do browser.
  // `score_final` mora aqui porque é insumo da inversão: com os pesos e os sub-scores dá para
  // isolar o termo de EIP e recuperar a margem a menos de uma transformação afim.
  _admin?: {
    score_final: number;
    cost_final: number | null;
    estimated_cost_for_ranking: number | null;
    cost_source: string;
    cost_confidence: number;
    assoc_score: number;
    sim_score: number;
    ctx_score: number;
    penalties: number;
    familia: string | null;
    eiltv: number | null;
  };
}

export interface RecommendationResult {
  recommendations: RecommendationItem[];
  meta: {
    total_candidates: number;
    mode: 'profit' | 'ltv';
    // Ausente sem cap_custo_ler: os pesos são insumo da inversão de `score_final`.
    weights?: { wA: number; wP: number; wS: number; wC: number };
    top_n: number;
  };
}

export function useRecommendationEngine() {
  const { user } = useAuth();
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

      // FU4-F/3: o strip client-side de `_admin` SAIU daqui.
      //
      // Ele nunca foi proteção — rodava DEPOIS de a resposta de rede chegar, então o custo já
      // estava no DevTools. Agora quem decide é a edge, por `private.cap_custo_ler`.
      //
      // E mantê-lo seria pior que inútil: `isAdmin` é `role === 'master'`, ESTRITAMENTE mais
      // restrito que cap_custo_ler (que também concede a employee `estrategico`/`super_admin`).
      // Duas autoridades discordando ⇒ a tela esconderia de quem o servidor autorizou.
      // A presença de `_admin` na resposta É a resposta do servidor; renderizar é o certo.
      // (O toggle `showAdminBreakdown` segue como controle de EXIBIÇÃO, e já exige `item._admin`.)
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
  }, [user?.id]);

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
