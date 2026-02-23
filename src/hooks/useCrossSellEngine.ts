import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

// ─── Types ───────────────────────────────────────────────────────────
export interface Recommendation {
  id?: string;
  customerId: string;
  customerName: string;
  type: 'cross_sell' | 'up_sell';
  productId: string;
  productName: string;
  currentProductId?: string;
  currentProductName?: string;
  pij: number;          // Probability of conversion
  mij: number;          // Incremental margin
  lie: number;          // Expected Incremental Profit
  complexityFactor: number;
  clusterVolume: number;
  status: 'pendente' | 'ofertado' | 'aceito' | 'rejeitado' | 'expirado';
}

export interface CustomerRecommendations {
  customerId: string;
  customerName: string;
  healthScore: number;
  crossSell: Recommendation[];
  upSell: Recommendation[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Main Hook ───────────────────────────────────────────────────────
export const useCrossSellEngine = () => {
  const { user } = useAuth();
  const [recommendations, setRecommendations] = useState<CustomerRecommendations[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);

  const calculateRecommendations = useCallback(async () => {
    if (!user?.id) return;
    setCalculating(true);
    setLoading(true);

    try {
      // 1. Load client scores (health, categories, engagement)
      const { data: clientScores } = await supabase
        .from('farmer_client_scores')
        .select('*')
        .eq('farmer_id', user.id) as any;

      if (!clientScores?.length) {
        setRecommendations([]);
        return;
      }

      // 2. Load all products with costs
      const { data: products } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, valor_unitario, metadata, ativo')
        .eq('ativo', true) as any;

      const { data: productCosts } = await supabase
        .from('product_costs')
        .select('product_id, cost_price') as any;

      const costMap = new Map<string, number>();
      (productCosts || []).forEach((pc: any) => costMap.set(pc.product_id, Number(pc.cost_price)));

      // 3. Load sales history for all customers
      const customerIds = clientScores.map((c: any) => c.customer_user_id);
      const { data: salesOrders } = await supabase
        .from('sales_orders')
        .select('customer_user_id, items, total, created_at')
        .in('customer_user_id', customerIds)
        .in('status', ['confirmado', 'faturado', 'entregue']) as any;

      // 4. Load category conversion rates (learning data)
      const { data: conversionData } = await supabase
        .from('farmer_category_conversion')
        .select('*') as any;
      const conversionMap = new Map<string, any>();
      (conversionData || []).forEach((c: any) => conversionMap.set(c.category_id, c));

      // 5. Load customer profiles
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, customer_type, cnae')
        .in('user_id', customerIds);
      const profileMap = new Map<string, any>();
      (profiles || []).forEach((p: any) => profileMap.set(p.user_id, p));

      // 6. Build per-customer purchase history
      const customerProducts = new Map<string, Map<string, { qty: number; price: number; cost: number }>>();
      const allProductPurchases = new Map<string, number>(); // product_id -> total customers who bought

      for (const order of (salesOrders || [])) {
        const cid = order.customer_user_id;
        if (!customerProducts.has(cid)) customerProducts.set(cid, new Map());
        const cp = customerProducts.get(cid)!;

        const items = Array.isArray(order.items) ? order.items : [];
        for (const item of items) {
          if (!item.product_id) continue;
          const existing = cp.get(item.product_id) || { qty: 0, price: 0, cost: 0 };
          existing.qty += Number(item.quantity || 1);
          existing.price = Number(item.unit_price || 0);
          existing.cost = costMap.get(item.product_id) || 0;
          cp.set(item.product_id, existing);

          // Track which products are popular
          if (!allProductPurchases.has(item.product_id)) allProductPurchases.set(item.product_id, 0);
          allProductPurchases.set(item.product_id, allProductPurchases.get(item.product_id)! + 1);
        }
      }

      const totalCustomers = Math.max(customerIds.length, 1);
      const productList = products || [];

      // 7. Calculate recommendations per client
      const allRecs: CustomerRecommendations[] = [];

      for (const score of clientScores) {
        const cid = score.customer_user_id;
        const profile = profileMap.get(cid);
        if (!profile) continue;

        const healthScore = Number(score.health_score || 0);
        const customerPurchased = customerProducts.get(cid) || new Map();
        const purchasedIds = new Set(customerPurchased.keys());

        // Engagement factor: based on answer rate and responsiveness
        const answerRate = Number(score.answer_rate_60d || 0) / 100;
        const whatsappRate = Number(score.whatsapp_reply_rate_60d || 0) / 100;
        const engagementFactor = clamp(0.3 + 0.5 * answerRate + 0.2 * whatsappRate, 0.1, 1.0);

        const crossSellRecs: Recommendation[] = [];
        const upSellRecs: Recommendation[] = [];

        // ─── CROSS-SELL: Products not purchased but popular in cluster ───
        for (const product of productList) {
          if (purchasedIds.has(product.id)) continue;

          const cost = costMap.get(product.id) || 0;
          const price = Number(product.valor_unitario || 0);
          const margin = price - cost;
          if (margin <= 0) continue; // Skip negative margin products

          // Cluster adherence: how many similar customers bought this
          const buyerCount = allProductPurchases.get(product.id) || 0;
          const clusterAdherence = clamp(buyerCount / totalCustomers, 0, 1);
          if (clusterAdherence < 0.05) continue; // Less than 5% bought = not relevant

          // Historical conversion rate for this product
          const conv = conversionMap.get(product.id);
          const historicalRate = conv ? Number(conv.conversion_rate) : 0.15; // default 15%

          // P_ij = HistoricalRate × (HealthScore/100) × Engagement × ClusterAdherence
          const pij = historicalRate * (healthScore / 100) * engagementFactor * clusterAdherence;

          // M_ij = Margin × EstimatedClusterVolume
          const clusterVolume = Math.max(1, Math.round(buyerCount / totalCustomers * 12)); // monthly estimate
          const mij = margin * clusterVolume;

          // Complexity factor from learning data
          const complexityFactor = conv ? Number(conv.complexity_factor) : 1.0;

          // LIE_ij = P_ij × M_ij × ComplexityFactor
          const lie = pij * mij * complexityFactor;

          if (lie > 0) {
            crossSellRecs.push({
              customerId: cid,
              customerName: profile.name,
              type: 'cross_sell',
              productId: product.id,
              productName: product.descricao,
              pij: Math.round(pij * 1000) / 10,
              mij: Math.round(mij * 100) / 100,
              lie: Math.round(lie * 100) / 100,
              complexityFactor,
              clusterVolume,
              status: 'pendente',
            });
          }
        }

        // ─── UP-SELL: Find premium alternatives for current low-margin products ───
        for (const [purchasedId, purchaseData] of customerPurchased.entries()) {
          const currentMargin = purchaseData.price - purchaseData.cost;
          if (currentMargin <= 0 || purchaseData.price <= 0) continue;
          const currentMarginPct = currentMargin / purchaseData.price;
          if (currentMarginPct > 0.35) continue; // Already good margin, skip

          // Find premium alternatives (higher price, higher margin)
          for (const product of productList) {
            if (product.id === purchasedId) continue;
            if (purchasedIds.has(product.id)) continue;

            const premiumCost = costMap.get(product.id) || 0;
            const premiumPrice = Number(product.valor_unitario || 0);
            const premiumMargin = premiumPrice - premiumCost;

            // Must be genuinely premium: higher price AND higher margin
            if (premiumPrice <= purchaseData.price * 1.1) continue;
            if (premiumMargin <= currentMargin * 1.2) continue;

            const conv = conversionMap.get(product.id);
            const historicalRate = conv ? Number(conv.conversion_rate) : 0.10;

            // P_ij for up-sell
            const pij = historicalRate * (healthScore / 100) * engagementFactor * 0.8; // 0.8 = up-sell is harder

            // M_ij = (PremiumMargin - CurrentMargin) × CurrentVolume
            const mij = (premiumMargin - currentMargin) * purchaseData.qty;

            const complexityFactor = conv ? Number(conv.complexity_factor) : 1.0;
            const lie = pij * mij * complexityFactor;

            if (lie > 0) {
              const currentProduct = productList.find((p: any) => p.id === purchasedId);
              upSellRecs.push({
                customerId: cid,
                customerName: profile.name,
                type: 'up_sell',
                productId: product.id,
                productName: product.descricao,
                currentProductId: purchasedId,
                currentProductName: currentProduct?.descricao || 'Produto atual',
                pij: Math.round(pij * 1000) / 10,
                mij: Math.round(mij * 100) / 100,
                lie: Math.round(lie * 100) / 100,
                complexityFactor,
                clusterVolume: purchaseData.qty,
                status: 'pendente',
              });
            }
          }
        }

        // Sort by LIE descending, take top 3 cross-sell and top 2 up-sell
        crossSellRecs.sort((a, b) => b.lie - a.lie);
        upSellRecs.sort((a, b) => b.lie - a.lie);

        const topCross = crossSellRecs.slice(0, 3);
        const topUp = upSellRecs.slice(0, 2);

        if (topCross.length > 0 || topUp.length > 0) {
          allRecs.push({
            customerId: cid,
            customerName: profile.name,
            healthScore,
            crossSell: topCross,
            upSell: topUp,
          });
        }
      }

      // Sort customers by total LIE potential
      allRecs.sort((a, b) => {
        const totalA = [...a.crossSell, ...a.upSell].reduce((s, r) => s + r.lie, 0);
        const totalB = [...b.crossSell, ...b.upSell].reduce((s, r) => s + r.lie, 0);
        return totalB - totalA;
      });

      setRecommendations(allRecs);

      // Persist recommendations
      for (const cr of allRecs) {
        for (const rec of [...cr.crossSell, ...cr.upSell]) {
          await supabase.from('farmer_recommendations' as any).upsert({
            farmer_id: user.id,
            customer_user_id: rec.customerId,
            recommendation_type: rec.type,
            product_id: rec.productId,
            current_product_id: rec.currentProductId || null,
            p_ij: rec.pij,
            m_ij: rec.mij,
            lie: rec.lie,
            complexity_factor: rec.complexityFactor,
            cluster_volume_estimate: rec.clusterVolume,
            status: 'pendente',
            updated_at: new Date().toISOString(),
          } as any);
        }
      }
    } catch (error) {
      console.error('Error calculating recommendations:', error);
    } finally {
      setCalculating(false);
      setLoading(false);
    }
  }, [user?.id]);

  // ─── Actions ─────────────────────────────────────────────────────────
  const markAsOffered = useCallback(async (recId: string) => {
    await supabase.from('farmer_recommendations' as any)
      .update({ status: 'ofertado', offered_at: new Date().toISOString() } as any)
      .eq('id', recId);
  }, []);

  const markAsAccepted = useCallback(async (recId: string, actualMargin?: number, timeSpent?: number) => {
    const update: any = {
      status: 'aceito',
      accepted_at: new Date().toISOString(),
    };
    if (actualMargin !== undefined) update.actual_margin = actualMargin;
    if (timeSpent !== undefined) update.time_spent_seconds = timeSpent;

    await supabase.from('farmer_recommendations' as any).update(update).eq('id', recId);

    // Update category conversion rates (learning)
    if (actualMargin !== undefined) {
      const { data: rec } = await supabase.from('farmer_recommendations' as any)
        .select('product_id').eq('id', recId).single();
      if (rec) {
        await updateConversionStats((rec as any).product_id);
      }
    }
  }, []);

  const markAsRejected = useCallback(async (recId: string) => {
    await supabase.from('farmer_recommendations' as any)
      .update({ status: 'rejeitado', rejected_at: new Date().toISOString() } as any)
      .eq('id', recId);
  }, []);

  // Recalculate conversion stats from historical data
  const updateConversionStats = async (productId: string) => {
    const { data: recs } = await supabase.from('farmer_recommendations' as any)
      .select('status, actual_margin, time_spent_seconds')
      .eq('product_id', productId)
      .in('status', ['aceito', 'rejeitado', 'ofertado']) as any;

    if (!recs?.length) return;

    const offered = recs.filter((r: any) => ['aceito', 'rejeitado', 'ofertado'].includes(r.status)).length;
    const accepted = recs.filter((r: any) => r.status === 'aceito').length;
    const rate = offered > 0 ? accepted / offered : 0;

    const acceptedRecs = recs.filter((r: any) => r.status === 'aceito' && r.actual_margin != null);
    const avgMargin = acceptedRecs.length > 0
      ? acceptedRecs.reduce((s: number, r: any) => s + Number(r.actual_margin), 0) / acceptedRecs.length
      : 0;

    const withTime = acceptedRecs.filter((r: any) => r.time_spent_seconds != null);
    const avgTime = withTime.length > 0
      ? Math.round(withTime.reduce((s: number, r: any) => s + r.time_spent_seconds, 0) / withTime.length)
      : 0;

    const profitPerHour = avgTime > 0 ? (avgMargin / (avgTime / 3600)) : 0;

    // Complexity factor: higher profit/hour = lower complexity (easier to sell)
    const complexity = profitPerHour > 0 ? clamp(1.0 / (1 + Math.log(1 + profitPerHour / 100)), 0.5, 1.5) : 1.0;

    await supabase.from('farmer_category_conversion' as any).upsert({
      category_id: productId,
      total_offers: offered,
      total_accepts: accepted,
      conversion_rate: Math.round(rate * 1000) / 1000,
      avg_margin_generated: Math.round(avgMargin * 100) / 100,
      avg_time_spent_seconds: avgTime,
      profit_per_hour: Math.round(profitPerHour * 100) / 100,
      complexity_factor: Math.round(complexity * 1000) / 1000,
      updated_at: new Date().toISOString(),
    } as any);
  };

  return {
    recommendations,
    loading,
    calculating,
    calculateRecommendations,
    markAsOffered,
    markAsAccepted,
    markAsRejected,
  };
};
