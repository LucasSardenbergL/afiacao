import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';
import { fetchAllPages } from '@/lib/postgrest';

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
  /** Sem `cost`/`margin`: o custo não chega mais ao browser, e `price` é público (o cliente o vê). */
  products: { id: string; name: string; price: number }[];
  support: number;
  confidence: number;
  lift: number;
  pBundle: number;
  /**
   * Score de AFINIDADE do bundle — adimensional, NÃO é dinheiro. Ver `Recommendation.affinityScore`
   * em useCrossSellEngine para o racional completo (custo fora do browser → não existe mais
   * "lucro esperado"; `complexityFactor` fica fora do score porque a fórmula é invertida e a
   * tabela que o alimenta é escrivível por employee).
   *
   * ⚠️ Nunca formatar como R$. E NÃO comparar com `Recommendation.affinityScore` do motor
   * individual: `pBundle` multiplica por `lift/2` e não é limitado a 1, então as duas escalas
   * não são comensuráveis (apontado pelo Codex na rodada 3).
   */
  affinityBundle: number;
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
  avgMonthlySpend: number;
  grossMarginPct: number;
  categoryCount: number;
  daysSinceLastPurchase: number;
  cnae: string;
  customerType: string;
  recentProducts: string[];
}

// ─── Row types ─────────────────────────────────────────────────────
interface ClientScoreRow {
  customer_user_id: string;
  health_score: number | string | null;
  answer_rate_60d: number | string | null;
  whatsapp_reply_rate_60d: number | string | null;
  avg_monthly_spend_180d: number | string | null;
  gross_margin_pct: number | string | null;
  category_count: number | string | null;
  days_since_last_purchase: number | string | null;
}

interface ProductRow {
  id: string;
  codigo: string | null;
  descricao: string;
  valor_unitario: number | string | null;
  metadata: unknown;
  ativo: boolean | null;
  omie_codigo_produto: number | string | null;
}

interface ProfileRow {
  user_id: string;
  name: string | null;
  customer_type: string | null;
  cnae: string | null;
}

interface ConversionRow {
  category_id: string;
  complexity_factor: number | string | null;
}

interface SalesOrderItem {
  product_id?: string;
  omie_codigo_produto?: number | string;
}

interface SalesOrderRow {
  customer_user_id: string;
  items: SalesOrderItem[] | unknown;
  total: number | string | null;
  created_at: string;
}

interface ExistingRecRow {
  product_id: string;
  lie: number | string | null;
  recommendation_type: 'cross_sell' | 'up_sell';
}

interface StatsRecRow {
  status: string;
  actual_margin: number | string | null;
  time_spent_seconds: number | null;
}

interface BundleStatsRow extends StatsRecRow {
  bundle_products: { id: string }[] | unknown;
}

interface BundleAcceptUpdate {
  status: 'aceito_total' | 'aceito_parcial';
  accepted_at: string;
  updated_at: string;
  accepted_products?: string[];
  actual_margin?: number;
  time_spent_seconds?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Configuration ──────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  minSupport: 0.01,      // 1% — was 5%, too restrictive with many products
  minLift: 1.05,         // was 1.2, lowered to capture more meaningful rules
  sequentialWindowDays: 90,
  bundleSizeMin: 2,
  bundleSizeMax: 3,
};

// ─── Main Hook ───────────────────────────────────────────────────────
export const useBundleEngine = () => {
  // Lente "Ver como": id efetivo = ALVO na lente (lê/recalcula os bundles DELE pra
  // inspeção), próprio usuário fora. Na lente a persistência (regras + recomendações)
  // é PULADA (igual useCrossSellEngine/useFarmerScoring): o master inspeciona, não
  // regrava a carteira do alvo. Fora da lente effectiveUserId === user.id (byte-
  // equivalente, zero regressão).
  const { effectiveUserId, isImpersonating } = useImpersonation();
  const [customerBundles, setCustomerBundles] = useState<CustomerBundles[]>([]);
  const [rules, setRules] = useState<AssociationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);

  const calculateBundles = useCallback(async (config = DEFAULT_CONFIG) => {
    if (!effectiveUserId) return;
    setCalculating(true);
    setLoading(true);

    try {
      // 1. Load data with fallback for super_admin
      const fetchAllScores = async (filterFarmerId?: string): Promise<ClientScoreRow[]> => {
        const all: ClientScoreRow[] = [];
        let page = 0;
        const sz = 1000;
        let hasMore = true;
        while (hasMore) {
          let q = supabase.from('farmer_client_scores').select('*').range(page * sz, (page + 1) * sz - 1);
          if (filterFarmerId) q = q.eq('farmer_id', filterFarmerId);
          const { data } = (await q) as unknown as { data: ClientScoreRow[] | null };
          if (!data || data.length === 0) hasMore = false;
          else { all.push(...data); if (data.length < sz) hasMore = false; page++; }
        }
        return all;
      };

      // Try farmer-specific first, fallback to all (super_admin). Na lente NÃO cai no
      // fallback "todos os scores" — escopa estritamente ao alvo (degradação honesta:
      // alvo sem score → lista vazia, nunca a carteira de todo mundo).
      let clientScores = await fetchAllScores(effectiveUserId);
      if (!clientScores.length && !isImpersonating) clientScores = await fetchAllScores();

      // As duas primeiras estouram a capa de 1.000 do PostgREST (3.108 SKUs ativos, 5.668
      // perfis) e vinham truncadas em silêncio: o profileMap deixava a maioria dos clientes sem
      // perfil — e sem perfil o cliente é pulado (`if (!profile) continue`), ou seja, nunca
      // recebia bundle. farmer_category_conversion não pagina: a tabela está vazia hoje.
      const [products, profiles, conversionResult, vendaveisResult] = await Promise.all([
        fetchAllPages<ProductRow>((de, ate) =>
          supabase
            .from('omie_products')
            .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto')
            .eq('ativo', true)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null }>,
        ),
        fetchAllPages<ProfileRow>((de, ate) =>
          supabase
            .from('profiles')
            .select('user_id, name, customer_type, cnae')
            .order('user_id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ProfileRow[] | null }>,
        ),
        supabase.from('farmer_category_conversion').select('*') as unknown as Promise<{ data: ConversionRow[] | null }>,
        // Quais SKUs são VENDÁVEIS (margem canônica > 0) — o browser não vê mais custo.
        supabase.rpc('get_skus_margem_positiva') as unknown as Promise<{ data: { product_id: string }[] | null; error: unknown }>,
      ]);
      const conversionData = conversionResult.data;

      // FAIL-CLOSED: falha na RPC → NENHUM bundle. Degradar para "monta bundle com tudo" poria
      // produto de PREJUÍZO na oferta combinada, que é o pior desfecho possível aqui.
      if (vendaveisResult.error || !vendaveisResult.data) {
        console.error('get_skus_margem_positiva falhou — sem bundles (fail-closed):', vendaveisResult.error);
        setCustomerBundles([]);
        return;
      }
      const vendaveis = new Set(vendaveisResult.data.map((r) => r.product_id));

      if (!clientScores?.length) { setCustomerBundles([]); return; }

      // Load ALL sales orders (avoid huge .in() URL)
      const fetchAllSalesOrders = async (): Promise<SalesOrderRow[]> => {
        const all: SalesOrderRow[] = [];
        let page = 0;
        const sz = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data } = (await supabase
            .from('sales_orders')
            .select('customer_user_id, items, total, created_at')
            .in('status', ['confirmado', 'faturado', 'entregue'])
            .range(page * sz, (page + 1) * sz - 1)) as unknown as { data: SalesOrderRow[] | null };
          if (!data || data.length === 0) hasMore = false;
          else { all.push(...data); if (data.length < sz) hasMore = false; page++; }
        }
        return all;
      };
      const salesOrders = await fetchAllSalesOrders();

      // Build maps
      const productMap = new Map<string, ProductRow>();
      (products || []).forEach((p) => productMap.set(p.id, p));
      const omieToProductId = new Map<number, string>();
      (products || []).forEach((p) => {
        if (p.omie_codigo_produto) omieToProductId.set(Number(p.omie_codigo_produto), p.id);
      });
      const profileMap = new Map<string, ProfileRow>();
      (profiles || []).forEach((p) => profileMap.set(p.user_id, p));
      const conversionMap = new Map<string, ConversionRow>();
      (conversionData || []).forEach((c) => conversionMap.set(c.category_id, c));

      // 2. Build transaction baskets per customer
      const baskets: string[][] = [];
      const customerBaskets = new Map<string, Set<string>>();
      const sequentialPurchases = new Map<string, { productId: string; date: Date }[]>();

      for (const order of salesOrders || []) {
        const items: SalesOrderItem[] = Array.isArray(order.items) ? (order.items as SalesOrderItem[]) : [];
        const productIds = items.map((i) => {
          if (i.product_id) return i.product_id;
          if (i.omie_codigo_produto) return omieToProductId.get(Number(i.omie_codigo_produto));
          return null;
        }).filter((id): id is string => Boolean(id));
        if (productIds.length > 0) {
          baskets.push(productIds);
          if (!customerBaskets.has(order.customer_user_id)) customerBaskets.set(order.customer_user_id, new Set());
          productIds.forEach((pid) => customerBaskets.get(order.customer_user_id)!.add(pid));

          // Sequential tracking
          if (!sequentialPurchases.has(order.customer_user_id)) sequentialPurchases.set(order.customer_user_id, []);
          productIds.forEach((pid) => {
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

      // Persist top rules — PULADO na lente "Ver como" (a tabela é GLOBAL: o delete
      // apaga as regras de toda a base; o master inspeciona os bundles do alvo sem
      // recalcular regras/recomendações da carteira dele).
      if (!isImpersonating) {
        await supabase.from('farmer_association_rules').delete().neq('id', '00000000-0000-0000-0000-000000000000');
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
          await supabase.from('farmer_association_rules').insert(rulesToInsert);
        }
      }

      // 5. Generate bundles per customer
      const allCustomerBundles: CustomerBundles[] = [];

      for (const score of clientScores) {
        const cid = score.customer_user_id;
        const profile = profileMap.get(cid);
        if (!profile) continue;

        const healthScore = Math.max(Number(score.health_score || 0), 10);
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
            // O custo decide EXCLUSÃO, nunca ORDEM: só entra SKU que a RPC listou como vendável
            // (margem canônica > 0). Sem custo conhecido não entra — ausente≠zero (#1466).
            if (!vendaveis.has(pid)) continue;
            const price = Number(product.valor_unitario || 0);

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
                // Mesmo motivo do produto principal: só o vendável entra no par.
                if (!vendaveis.has(relatedPid)) continue;
                const relatedPrice = Number(relatedProduct.valor_unitario || 0);

                const comboKey = [pid, relatedPid].sort().join('|');
                if (usedCombos.has(comboKey)) continue;
                usedCombos.add(comboKey);

                // Bundle metrics
                const avgConfidence = (rule.confidence + related.confidence) / 2;
                const avgLift = (rule.lift + related.lift) / 2;
                const avgSupport = (rule.support + related.support) / 2;

                const pBundle = avgConfidence * (avgLift / 2) * (healthScore / 100) * engagementFactor;

                const conv1 = conversionMap.get(pid);
                const conv2 = conversionMap.get(relatedPid);
                const cf1 = conv1 ? Number(conv1.complexity_factor) : 1.0;
                const cf2 = conv2 ? Number(conv2.complexity_factor) : 1.0;
                // Guardado como dado aprendido; NÃO multiplica o score (ver affinityBundle).
                const complexityFactor = (cf1 + cf2) / 2;

                const affinityBundle = pBundle;

                if (affinityBundle > 0) {
                  bundles.push({
                    customerId: cid,
                    customerName: profile.name ?? '',
                    products: [
                      { id: pid, name: product.descricao, price },
                      { id: relatedPid, name: relatedProduct.descricao, price: relatedPrice },
                    ],
                    support: avgSupport,
                    confidence: avgConfidence,
                    lift: avgLift,
                    pBundle: Math.round(pBundle * 1000) / 10,
                    affinityBundle: Math.round(affinityBundle * 10000) / 10000,
                    complexityFactor,
                    status: 'pendente',
                  });
                }
              }
            }
          }
        }

        // Ordena por AFINIDADE, top 2
        bundles.sort((a, b) => b.affinityBundle - a.affinityBundle);
        const topBundles = bundles.slice(0, 2);

        // Best individual product (from cross-sell engine data)
        let bestIndividual: IndividualComparison | null = null;
        const { data: existingRecs } = (await supabase
          .from('farmer_recommendations')
          .select('product_id, lie, recommendation_type')
          .eq('farmer_id', effectiveUserId)
          .eq('customer_user_id', cid)
          .eq('status', 'pendente')
          .order('lie', { ascending: false })
          .limit(1)) as unknown as { data: ExistingRecRow[] | null };

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
          const purchasedProducts = [...purchased]
            .map((pid) => productMap.get(pid)?.descricao)
            .filter((d): d is string => Boolean(d));
          allCustomerBundles.push({
            customerId: cid,
            customerName: profile.name ?? '',
            healthScore,
            bundles: topBundles,
            bestIndividual,
            avgMonthlySpend: Number(score.avg_monthly_spend_180d || 0),
            grossMarginPct: Number(score.gross_margin_pct || 0),
            categoryCount: Number(score.category_count || 0),
            daysSinceLastPurchase: Number(score.days_since_last_purchase || 0),
            cnae: profile.cnae || '',
            customerType: profile.customer_type || '',
            recentProducts: purchasedProducts.slice(0, 5),
          });
        }
      }

      // Ordena clientes pela MELHOR afinidade de bundle (não pela soma — somar scores premia
      // quem tem mais bundles na lista, não quem tem a melhor oferta).
      allCustomerBundles.sort(
        (a, b) =>
          Math.max(0, ...b.bundles.map((x) => x.affinityBundle)) -
          Math.max(0, ...a.bundles.map((x) => x.affinityBundle)),
      );

      setCustomerBundles(allCustomerBundles);

      // Persist bundle recommendations — PULADO na lente "Ver como" (só leitura: o
      // master inspeciona os bundles do alvo sem regravar a carteira dele).
      if (!isImpersonating) {
        for (const cb of allCustomerBundles) {
          for (const bundle of cb.bundles) {
            await supabase.from('farmer_bundle_recommendations').insert({
              farmer_id: effectiveUserId,
              customer_user_id: bundle.customerId,
              // Sem `cost`/`margin` por SKU — o jsonb guardava o custo LITERAL (12/12 linhas em
              // prod). Só id/name/price, e `price` é público.
              bundle_products: bundle.products as unknown as Json,
              support: bundle.support,
              confidence: bundle.confidence,
              lift: bundle.lift,
              p_bundle: bundle.pBundle,
              // m_bundle era a SOMA das margens; e mesmo apagando-o, `lie_bundle` monetário
              // invertia sozinho: m_bundle ≈ lie_bundle / ((p_bundle/100) × complexity_factor).
              // Por isso os dois mudam juntos — `lie_bundle` passa a guardar o score de afinidade
              // (mantido populado porque OfertaCruaCard/useTacticalPlan ordenam por ele).
              m_bundle: null,
              lie_bundle: bundle.affinityBundle,
              complexity_factor: bundle.complexityFactor,
              status: 'pendente',
            });
          }
        }
      }

      toast.success(`${discoveredRules.length} regras e ${allCustomerBundles.reduce((s, c) => s + c.bundles.length, 0)} bundles gerados`);
    } catch (error) {
      console.error('Error calculating bundles:', error);
      toast.error('Erro ao calcular bundles');
    } finally {
      setCalculating(false);
      setLoading(false);
    }
  }, [effectiveUserId, isImpersonating]);

  // ─── Actions ─────────────────────────────────────────────────────────
  const markBundleOffered = useCallback(async (bundleId: string) => {
    await supabase.from('farmer_bundle_recommendations')
      .update({ status: 'ofertado', offered_at: new Date().toISOString() })
      .eq('id', bundleId);
  }, []);

  const markBundleAccepted = useCallback(async (
    bundleId: string,
    acceptType: 'total' | 'parcial',
    acceptedProducts?: string[],
    actualMargin?: number,
    timeSpent?: number
  ) => {
    const update: BundleAcceptUpdate = {
      status: acceptType === 'total' ? 'aceito_total' : 'aceito_parcial',
      accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (acceptedProducts) update.accepted_products = acceptedProducts;
    if (actualMargin !== undefined) update.actual_margin = actualMargin;
    if (timeSpent !== undefined) update.time_spent_seconds = timeSpent;

    await supabase.from('farmer_bundle_recommendations').update(update).eq('id', bundleId);

    // Update conversion stats for each product
    if (acceptedProducts && actualMargin !== undefined) {
      for (const pid of acceptedProducts) {
        await updateConversionStats(pid);
      }
    }
    toast.success('Bundle atualizado');
  }, []);

  const markBundleRejected = useCallback(async (bundleId: string) => {
    await supabase.from('farmer_bundle_recommendations')
      .update({ status: 'rejeitado', rejected_at: new Date().toISOString() })
      .eq('id', bundleId);
  }, []);

  const updateConversionStats = async (productId: string) => {
    const { data: recs } = (await supabase.from('farmer_recommendations')
      .select('status, actual_margin, time_spent_seconds')
      .eq('product_id', productId)
      .in('status', ['aceito', 'rejeitado', 'ofertado'])) as unknown as { data: StatsRecRow[] | null };

    const { data: bundleRecs } = (await supabase.from('farmer_bundle_recommendations')
      .select('status, actual_margin, time_spent_seconds, bundle_products')
      .in('status', ['aceito_total', 'aceito_parcial', 'rejeitado', 'ofertado'])) as unknown as { data: BundleStatsRow[] | null };

    const allRecs: StatsRecRow[] = [
      ...(recs || []),
      ...(bundleRecs || []).filter((b) => {
        const prods = Array.isArray(b.bundle_products) ? (b.bundle_products as { id: string }[]) : [];
        return prods.some((p) => p.id === productId);
      }),
    ];

    if (!allRecs.length) return;

    const offered = allRecs.length;
    const accepted = allRecs.filter((r) =>
      ['aceito', 'aceito_total', 'aceito_parcial'].includes(r.status)
    ).length;
    const rate = offered > 0 ? accepted / offered : 0;

    const withMargin = allRecs.filter((r) => r.actual_margin != null);
    const avgMargin = withMargin.length > 0
      ? withMargin.reduce((s, r) => s + Number(r.actual_margin), 0) / withMargin.length
      : 0;

    const withTime = allRecs.filter((r): r is StatsRecRow & { time_spent_seconds: number } => r.time_spent_seconds != null);
    const avgTime = withTime.length > 0
      ? Math.round(withTime.reduce((s, r) => s + r.time_spent_seconds, 0) / withTime.length)
      : 0;

    const profitPerHour = avgTime > 0 ? (avgMargin / (avgTime / 3600)) : 0;
    const complexity = profitPerHour > 0 ? clamp(1.0 / (1 + Math.log(1 + profitPerHour / 100)), 0.5, 1.5) : 1.0;

    await supabase.from('farmer_category_conversion').upsert({
      category_id: productId,
      total_offers: offered,
      total_accepts: accepted,
      conversion_rate: Math.round(rate * 1000) / 1000,
      avg_margin_generated: Math.round(avgMargin * 100) / 100,
      avg_time_spent_seconds: avgTime,
      profit_per_hour: Math.round(profitPerHour * 100) / 100,
      complexity_factor: Math.round(complexity * 1000) / 1000,
      updated_at: new Date().toISOString(),
    });
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
