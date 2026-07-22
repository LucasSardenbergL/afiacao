import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';
import { margemConhecida } from '@/lib/scoring/margin';
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
  /** `null` = margem não apurada. NÃO trocar por 0: 0 classifica o cliente como "sensível a
   *  preço" via `classifyCustomerProfile`, um veredito que a ausência de dado não sustenta. */
  grossMarginPct: number | null;
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

// ─── Premissa do LIE do bundle (NÃO é aprendida) ─────────────────────
// Constante ARBITRADA, não medição. Até 2026-07-21 o hook lia
// `farmer_category_conversion` para derivar um fator por produto e caía neste
// mesmo 1.0 quando não achava a linha — sugerindo um "aprendizado histórico" que
// nunca existiu: a tabela tem 0 linhas desde fev/2026 (`n_tup_ins = 0`), porque o
// único writer ficava atrás de `markBundleAccepted`, que nenhuma UI chamou.
// Como é idêntica para todo bundle, é fator de ESCALA: não altera o RANKING, só o
// valor absoluto em R$ — rotulado na tela como estimativa não calibrada.
// Ver docs/historico/farmer-aprendizado-conversao.md.
const FATOR_COMPLEXIDADE = 1.0;

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
      // Loop MANUAL com o mesmo defeito que o #1545 tirou do `fetchAllPages` — por não CHAMAR
      // o helper, ficou de fora daquele grep: descartava o `error`, tratava `data: null` como
      // fim da tabela e não pedia `.order()` (ordem indefinida entre páginas pula e repete
      // linha). `customer_user_id` é UNIQUE na tabela.
      //
      // E a página perdida trocava o ESCOPO: o caller abaixo lê lista vazia como "não tem
      // carteira, deve ser super_admin" e recarrega SEM filtro de farmer_id.
      const fetchAllScores = (filterFarmerId?: string): Promise<ClientScoreRow[]> =>
        fetchAllPages<ClientScoreRow>(
          (de, ate) => {
            let q = supabase.from('farmer_client_scores').select('*');
            if (filterFarmerId) q = q.eq('farmer_id', filterFarmerId);
            return q.order('customer_user_id', { ascending: true }).range(de, ate) as unknown as
              PromiseLike<{ data: ClientScoreRow[] | null; error: unknown }>;
          },
          'farmer_client_scores/bundle',
        );

      // Try farmer-specific first, fallback to all (super_admin). Na lente NÃO cai no
      // fallback "todos os scores" — escopa estritamente ao alvo (degradação honesta:
      // alvo sem score → lista vazia, nunca a carteira de todo mundo).
      let clientScores = await fetchAllScores(effectiveUserId);
      if (!clientScores.length && !isImpersonating) clientScores = await fetchAllScores();

      // As duas paginadas estouram a capa de 1.000 do PostgREST (3.108 SKUs ativos, 5.668
      // perfis) e vinham truncadas em silêncio: o profileMap deixava a maioria dos clientes sem
      // perfil — e sem perfil o cliente é pulado (`if (!profile) continue`), ou seja, nunca
      // recebia bundle. A terceira leitura era `product_costs`, que saiu: o custo não chega mais
      // ao browser (a RPC abaixo responde só "este SKU é vendável?").
      const [products, profiles, vendaveisResult] = await Promise.all([
        fetchAllPages<ProductRow>((de, ate) =>
          supabase
            .from('omie_products')
            .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto')
            .eq('ativo', true)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null; error: unknown }>,
          'omie_products/bundle',
        ),
        fetchAllPages<ProfileRow>((de, ate) =>
          supabase
            .from('profiles')
            .select('user_id, name, customer_type, cnae')
            .order('user_id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ProfileRow[] | null; error: unknown }>,
          'profiles/bundle',
        ),
        // Quais SKUs são VENDÁVEIS (margem canônica > 0) — o browser não vê mais custo.
        supabase.rpc('get_skus_margem_positiva') as unknown as Promise<{ data: { product_id: string }[] | null; error: unknown }>,
      ]);

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
      // Mesmo defeito do loop manual acima — aqui a perda é do HISTÓRICO que alimenta as regras
      // de associação do bundle. `.order('id')` (PK) é a ordem estável; a coluna não precisa
      // estar no `select`.
      const salesOrders = await fetchAllPages<SalesOrderRow>(
        (de, ate) =>
          supabase
            .from('sales_orders')
            .select('customer_user_id, items, total, created_at')
            .in('status', ['confirmado', 'faturado', 'entregue'])
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: SalesOrderRow[] | null; error: unknown }>,
        'sales_orders/bundle',
      );

      // Build maps
      const productMap = new Map<string, ProductRow>();
      (products || []).forEach((p) => productMap.set(p.id, p));
      const omieToProductId = new Map<number, string>();
      (products || []).forEach((p) => {
        if (p.omie_codigo_produto) omieToProductId.set(Number(p.omie_codigo_produto), p.id);
      });
      const profileMap = new Map<string, ProfileRow>();
      (profiles || []).forEach((p) => profileMap.set(p.user_id, p));

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

                // Constante (ver bloco de premissas): a média dos dois fatores é ela mesma.
                // Persistida como dado, mas NÃO multiplica o score — sendo 1.0 e igual para todo
                // par, multiplicar por ela não muda ORDEM nenhuma. Ver `affinityBundle`.
                const complexityFactor = FATOR_COMPLEXIDADE;

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
            grossMarginPct: margemConhecida(score.gross_margin_pct),
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
  // `markBundleOffered` / `markBundleAccepted` / `markBundleRejected` e o
  // `updateConversionStats` que gravava `farmer_category_conversion` foram removidos
  // em 2026-07-21: nenhum componente os importava (`useFarmerBundles` consome apenas
  // `calculateBundles`), então o desfecho de um bundle nunca foi registrado. Havia
  // ainda um bug latente no writer — o `upsert` não passava `onConflict`, e como a PK
  // é `id` (uuid default, ausente do payload) o INSERT nunca conflitava pela PK e
  // violaria o UNIQUE de `category_id` a partir da 2ª gravação, em silêncio (o retorno
  // não era checado). Ver docs/historico/farmer-aprendizado-conversao.md.

  return {
    customerBundles,
    rules,
    loading,
    calculating,
    calculateBundles,
    config: DEFAULT_CONFIG,
  };
};
