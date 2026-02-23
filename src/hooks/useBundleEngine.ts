import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

// ─── Types ───────────────────────────────────────────────────────────
export interface AssociationRule {
  antecedent: string[];
  consequent: string[];
  antecedentNames: string[];
  consequentNames: string[];
  support: number;
  confidence: number;
  lift: number;
  type: 'association' | 'sequential';
}

export interface BundleRecommendation {
  id?: string;
  customerId: string;
  customerName: string;
  products: { id: string; name: string; price: number; cost: number; margin: number }[];
  support: number;
  confidence: number;
  lift: number;
  pBundle: number;
  mBundle: number;
  lieBundle: number;
  complexityFactor: number;
  status: string;
}

export interface IndividualComparison {
  productId: string;
  productName: string;
  lie: number;
  type: 'cross_sell' | 'up_sell';
}

export interface CustomerBundles {
  customerId: string;
  customerName: string;
  healthScore: number;
  bundles: BundleRecommendation[];
  bestIndividual: IndividualComparison | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Configuration ──────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  minSupport: 0.05,
  minLift: 1.2,
  sequentialWindowDays: 90,
  bundleSizeMin: 2,
  bundleSizeMax: 3,
};

// ─── Main Hook ───────────────────────────────────────────────────────
export const useBundleEngine = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [customerBundles, setCustomerBundles] = useState<CustomerBundles[]>([]);
  const [rules, setRules] = useState<AssociationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);

  const calculateBundles = useCallback(async (config = DEFAULT_CONFIG) => {
    if (!user?.id) return;
    setCalculating(true);
    setLoading(true);

    try {
      // 1. Load data
      const [
        { data: clientScores },
        { data: products },
        { data: productCosts },
        { data: profiles },
        { data: conversionData },
      ] = await Promise.all([
        supabase.from('farmer_client_scores').select('*').eq('farmer_id', user.id) as any,
        supabase.from('omie_products').select('id, codigo, descricao, valor_unitario, metadata, ativo').eq('ativo', true) as any,
        supabase.from('product_costs').select('product_id, cost_price') as any,
        supabase.from('profiles').select('user_id, name, customer_type, cnae') as any,
        supabase.from('farmer_category_conversion').select('*') as any,
      ]);

      if (!clientScores?.length) { setCustomerBundles([]); return; }

      const customerIds = clientScores.map((c: any) => c.customer_user_id);
      const { data: salesOrders } = await supabase
        .from('sales_orders')
        .select('customer_user_id, items, total, created_at')
        .in('customer_user_id', customerIds)
        .in('status', ['confirmado', 'faturado', 'entregue']) as any;

      // Build maps
      const costMap = new Map<string, number>();
      (productCosts || []).forEach((pc: any) => costMap.set(pc.product_id, Number(pc.cost_price)));
      const productMap = new Map<string, any>();
      (products || []).forEach((p: any) => productMap.set(p.id, p));
      const profileMap = new Map<string, any>();
      (profiles || []).forEach((p: any) => profileMap.set(p.user_id, p));
      const conversionMap = new Map<string, any>();
      (conversionData || []).forEach((c: any) => conversionMap.set(c.category_id, c));

      // 2. Build transaction baskets per customer
      const baskets: string[][] = [];
      const customerBaskets = new Map<string, Set<string>>();
      const sequentialPurchases = new Map<string, { productId: string; date: Date }[]>();

      for (const order of (salesOrders || [])) {
        const items = Array.isArray(order.items) ? order.items : [];
        const productIds = items.filter((i: any) => i.product_id).map((i: any) => i.product_id);
        if (productIds.length > 0) {
          baskets.push(productIds);
          if (!customerBaskets.has(order.customer_user_id)) customerBaskets.set(order.customer_user_id, new Set());
          productIds.forEach((pid: string) => customerBaskets.get(order.customer_user_id)!.add(pid));
          
          // Sequential tracking
          if (!sequentialPurchases.has(order.customer_user_id)) sequentialPurchases.set(order.customer_user_id, []);
          productIds.forEach((pid: string) => {
            sequentialPurchases.get(order.customer_user_id)!.push({
              productId: pid,
              date: new Date(order.created_at),
            });
          });
        }
      }

      const totalBaskets = Math.max(baskets.length, 1);

      // 3. Association rule mining (Apriori-like)
      // Count item frequencies
      const itemFreq = new Map<string, number>();
      for (const basket of baskets) {
        const unique = [...new Set(basket)];
        for (const item of unique) {
          itemFreq.set(item, (itemFreq.get(item) || 0) + 1);
        }
      }

      // Frequent items (support >= minSupport)
      const frequentItems = [...itemFreq.entries()]
        .filter(([, count]) => count / totalBaskets >= config.minSupport)
        .map(([id]) => id);

      // Count pairs
      const pairFreq = new Map<string, number>();
      for (const basket of baskets) {
        const unique = [...new Set(basket)].filter(id => frequentItems.includes(id));
        for (let i = 0; i < unique.length; i++) {
          for (let j = i + 1; j < unique.length; j++) {
            const key = [unique[i], unique[j]].sort().join('|');
            pairFreq.set(key, (pairFreq.get(key) || 0) + 1);
          }
        }
      }

      // Count triples
      const tripleFreq = new Map<string, number>();
      for (const basket of baskets) {
        const unique = [...new Set(basket)].filter(id => frequentItems.includes(id));
        for (let i = 0; i < unique.length; i++) {
          for (let j = i + 1; j < unique.length; j++) {
            for (let k = j + 1; k < unique.length; k++) {
              const key = [unique[i], unique[j], unique[k]].sort().join('|');
              tripleFreq.set(key, (tripleFreq.get(key) || 0) + 1);
            }
          }
        }
      }

      // Generate association rules
      const discoveredRules: AssociationRule[] = [];

      // Pair rules: A → B
      for (const [pairKey, pairCount] of pairFreq.entries()) {
        const [a, b] = pairKey.split('|');
        const support = pairCount / totalBaskets;
        if (support < config.minSupport) continue;

        const freqA = itemFreq.get(a) || 0;
        const freqB = itemFreq.get(b) || 0;

        // Rule: A → B
        const confAB = pairCount / freqA;
        const liftAB = confAB / (freqB / totalBaskets);
        if (liftAB >= config.minLift) {
          discoveredRules.push({
            antecedent: [a], consequent: [b],
            antecedentNames: [productMap.get(a)?.descricao || a],
            consequentNames: [productMap.get(b)?.descricao || b],
            support, confidence: confAB, lift: liftAB, type: 'association',
          });
        }

        // Rule: B → A
        const confBA = pairCount / freqB;
        const liftBA = confBA / (freqA / totalBaskets);
        if (liftBA >= config.minLift) {
          discoveredRules.push({
            antecedent: [b], consequent: [a],
            antecedentNames: [productMap.get(b)?.descricao || b],
            consequentNames: [productMap.get(a)?.descricao || a],
            support, confidence: confBA, lift: liftBA, type: 'association',
          });
        }
      }

      // 4. Sequential rules
      for (const [, purchases] of sequentialPurchases.entries()) {
        const sorted = [...purchases].sort((a, b) => a.date.getTime() - b.date.getTime());
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const daysDiff = (sorted[j].date.getTime() - sorted[i].date.getTime()) / (1000 * 60 * 60 * 24);
            if (daysDiff > config.sequentialWindowDays) break;
            if (sorted[i].productId === sorted[j].productId) continue;
            const key = `${sorted[i].productId}→${sorted[j].productId}`;
            // Count in a temp map (simplified: we already have pair data)
            const existingRule = discoveredRules.find(
              r => r.antecedent[0] === sorted[i].productId && r.consequent[0] === sorted[j].productId
            );
            if (existingRule && existingRule.type === 'association') {
              // Mark as also sequential
              existingRule.type = 'sequential';
            }
          }
        }
      }

      // Sort rules by lift
      discoveredRules.sort((a, b) => b.lift - a.lift);
      setRules(discoveredRules.slice(0, 50)); // Keep top 50

      // Persist top rules
      await supabase.from('farmer_association_rules' as any).delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (discoveredRules.length > 0) {
        const rulesToInsert = discoveredRules.slice(0, 50).map(r => ({
          antecedent_product_ids: r.antecedent,
          consequent_product_ids: r.consequent,
          support: Math.round(r.support * 10000) / 10000,
          confidence: Math.round(r.confidence * 10000) / 10000,
          lift: Math.round(r.lift * 100) / 100,
          rule_type: r.type,
          sample_size: totalBaskets,
        }));
        await supabase.from('farmer_association_rules' as any).insert(rulesToInsert as any);
      }

      // 5. Generate bundles per customer
      const allCustomerBundles: CustomerBundles[] = [];

      for (const score of clientScores) {
        const cid = score.customer_user_id;
        const profile = profileMap.get(cid);
        if (!profile) continue;

        const healthScore = Number(score.health_score || 0);
        const purchased = customerBaskets.get(cid) || new Set();

        // Engagement factor
        const answerRate = Number(score.answer_rate_60d || 0) / 100;
        const whatsappRate = Number(score.whatsapp_reply_rate_60d || 0) / 100;
        const engagementFactor = clamp(0.3 + 0.5 * answerRate + 0.2 * whatsappRate, 0.1, 1.0);

        // Find applicable rules: customer has antecedent but NOT consequent
        const applicableRules = discoveredRules.filter(rule => {
          const hasAntecedent = rule.antecedent.every(id => purchased.has(id));
          const missingConsequent = rule.consequent.some(id => !purchased.has(id));
          return hasAntecedent && missingConsequent;
        });

        // Generate bundles from rules (combine consequents)
        const bundles: BundleRecommendation[] = [];
        const usedCombos = new Set<string>();

        for (const rule of applicableRules) {
          const missingProducts = rule.consequent.filter(id => !purchased.has(id));
          
          // Single consequent bundle
          for (const pid of missingProducts) {
            const product = productMap.get(pid);
            if (!product) continue;
            const cost = costMap.get(pid) || 0;
            const price = Number(product.valor_unitario || 0);
            const margin = price - cost;
            if (margin <= 0) continue;

            // Try to build bundles of 2-3 by combining with other high-lift rules
            const relatedRules = applicableRules.filter(r2 =>
              r2 !== rule && r2.consequent.some(c => !purchased.has(c) && c !== pid)
            );

            // Bundle of 2: this product + one from related rule
            for (const related of relatedRules.slice(0, 3)) {
              for (const relatedPid of related.consequent) {
                if (purchased.has(relatedPid) || relatedPid === pid) continue;
                const relatedProduct = productMap.get(relatedPid);
                if (!relatedProduct) continue;
                const relatedCost = costMap.get(relatedPid) || 0;
                const relatedPrice = Number(relatedProduct.valor_unitario || 0);
                const relatedMargin = relatedPrice - relatedCost;
                if (relatedMargin <= 0) continue;

                const comboKey = [pid, relatedPid].sort().join('|');
                if (usedCombos.has(comboKey)) continue;
                usedCombos.add(comboKey);

                // Bundle metrics
                const avgConfidence = (rule.confidence + related.confidence) / 2;
                const avgLift = (rule.lift + related.lift) / 2;
                const avgSupport = (rule.support + related.support) / 2;

                const pBundle = avgConfidence * (avgLift / 2) * (healthScore / 100) * engagementFactor;
                const mBundle = margin + relatedMargin;

                const conv1 = conversionMap.get(pid);
                const conv2 = conversionMap.get(relatedPid);
                const cf1 = conv1 ? Number(conv1.complexity_factor) : 1.0;
                const cf2 = conv2 ? Number(conv2.complexity_factor) : 1.0;
                const complexityFactor = (cf1 + cf2) / 2;

                const lieBundle = pBundle * mBundle * complexityFactor;

                if (lieBundle > 0) {
                  bundles.push({
                    customerId: cid,
                    customerName: profile.name,
                    products: [
                      { id: pid, name: product.descricao, price, cost, margin },
                      { id: relatedPid, name: relatedProduct.descricao, price: relatedPrice, cost: relatedCost, margin: relatedMargin },
                    ],
                    support: avgSupport,
                    confidence: avgConfidence,
                    lift: avgLift,
                    pBundle: Math.round(pBundle * 1000) / 10,
                    mBundle: Math.round(mBundle * 100) / 100,
                    lieBundle: Math.round(lieBundle * 100) / 100,
                    complexityFactor,
                    status: 'pendente',
                  });
                }
              }
            }
          }
        }

        // Sort by LIE, take top 2
        bundles.sort((a, b) => b.lieBundle - a.lieBundle);
        const topBundles = bundles.slice(0, 2);

        // Best individual product (from cross-sell engine data)
        let bestIndividual: IndividualComparison | null = null;
        const { data: existingRecs } = await supabase
          .from('farmer_recommendations' as any)
          .select('product_id, lie, recommendation_type')
          .eq('farmer_id', user.id)
          .eq('customer_user_id', cid)
          .eq('status', 'pendente')
          .order('lie', { ascending: false })
          .limit(1) as any;

        if (existingRecs?.length) {
          const rec = existingRecs[0];
          const prod = productMap.get(rec.product_id);
          bestIndividual = {
            productId: rec.product_id,
            productName: prod?.descricao || 'Produto',
            lie: Number(rec.lie),
            type: rec.recommendation_type,
          };
        }

        if (topBundles.length > 0 || bestIndividual) {
          allCustomerBundles.push({
            customerId: cid,
            customerName: profile.name,
            healthScore,
            bundles: topBundles,
            bestIndividual,
          });
        }
      }

      // Sort by total bundle LIE
      allCustomerBundles.sort((a, b) => {
        const totalA = a.bundles.reduce((s, b) => s + b.lieBundle, 0);
        const totalB = b.bundles.reduce((s, b) => s + b.lieBundle, 0);
        return totalB - totalA;
      });

      setCustomerBundles(allCustomerBundles);

      // Persist bundle recommendations
      for (const cb of allCustomerBundles) {
        for (const bundle of cb.bundles) {
          await supabase.from('farmer_bundle_recommendations' as any).insert({
            farmer_id: user.id,
            customer_user_id: bundle.customerId,
            bundle_products: bundle.products,
            support: bundle.support,
            confidence: bundle.confidence,
            lift: bundle.lift,
            p_bundle: bundle.pBundle,
            m_bundle: bundle.mBundle,
            lie_bundle: bundle.lieBundle,
            complexity_factor: bundle.complexityFactor,
            status: 'pendente',
          } as any);
        }
      }

      toast({ title: `${discoveredRules.length} regras e ${allCustomerBundles.reduce((s, c) => s + c.bundles.length, 0)} bundles gerados` });
    } catch (error) {
      console.error('Error calculating bundles:', error);
      toast({ title: 'Erro ao calcular bundles', variant: 'destructive' });
    } finally {
      setCalculating(false);
      setLoading(false);
    }
  }, [user?.id, toast]);

  // ─── Actions ─────────────────────────────────────────────────────────
  const markBundleOffered = useCallback(async (bundleId: string) => {
    await supabase.from('farmer_bundle_recommendations' as any)
      .update({ status: 'ofertado', offered_at: new Date().toISOString() } as any)
      .eq('id', bundleId);
  }, []);

  const markBundleAccepted = useCallback(async (
    bundleId: string,
    acceptType: 'total' | 'parcial',
    acceptedProducts?: string[],
    actualMargin?: number,
    timeSpent?: number
  ) => {
    const update: any = {
      status: acceptType === 'total' ? 'aceito_total' : 'aceito_parcial',
      accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (acceptedProducts) update.accepted_products = acceptedProducts;
    if (actualMargin !== undefined) update.actual_margin = actualMargin;
    if (timeSpent !== undefined) update.time_spent_seconds = timeSpent;

    await supabase.from('farmer_bundle_recommendations' as any).update(update).eq('id', bundleId);

    // Update conversion stats for each product
    if (acceptedProducts && actualMargin !== undefined) {
      for (const pid of acceptedProducts) {
        await updateConversionStats(pid);
      }
    }
    toast({ title: 'Bundle atualizado' });
  }, [toast]);

  const markBundleRejected = useCallback(async (bundleId: string) => {
    await supabase.from('farmer_bundle_recommendations' as any)
      .update({ status: 'rejeitado', rejected_at: new Date().toISOString() } as any)
      .eq('id', bundleId);
  }, []);

  const updateConversionStats = async (productId: string) => {
    const { data: recs } = await supabase.from('farmer_recommendations' as any)
      .select('status, actual_margin, time_spent_seconds')
      .eq('product_id', productId)
      .in('status', ['aceito', 'rejeitado', 'ofertado']) as any;

    const { data: bundleRecs } = await supabase.from('farmer_bundle_recommendations' as any)
      .select('status, actual_margin, time_spent_seconds, bundle_products')
      .in('status', ['aceito_total', 'aceito_parcial', 'rejeitado', 'ofertado']) as any;

    const allRecs = [
      ...(recs || []).map((r: any) => ({ ...r, source: 'individual' })),
      ...(bundleRecs || []).filter((b: any) => {
        const prods = Array.isArray(b.bundle_products) ? b.bundle_products : [];
        return prods.some((p: any) => p.id === productId);
      }).map((r: any) => ({ ...r, source: 'bundle' })),
    ];

    if (!allRecs.length) return;

    const offered = allRecs.length;
    const accepted = allRecs.filter((r: any) =>
      ['aceito', 'aceito_total', 'aceito_parcial'].includes(r.status)
    ).length;
    const rate = offered > 0 ? accepted / offered : 0;

    const withMargin = allRecs.filter((r: any) => r.actual_margin != null);
    const avgMargin = withMargin.length > 0
      ? withMargin.reduce((s: number, r: any) => s + Number(r.actual_margin), 0) / withMargin.length
      : 0;

    const withTime = allRecs.filter((r: any) => r.time_spent_seconds != null);
    const avgTime = withTime.length > 0
      ? Math.round(withTime.reduce((s: number, r: any) => s + r.time_spent_seconds, 0) / withTime.length)
      : 0;

    const profitPerHour = avgTime > 0 ? (avgMargin / (avgTime / 3600)) : 0;
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
    customerBundles,
    rules,
    loading,
    calculating,
    calculateBundles,
    markBundleOffered,
    markBundleAccepted,
    markBundleRejected,
    config: DEFAULT_CONFIG,
  };
};
