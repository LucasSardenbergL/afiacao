import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { custoCanonico, margemUnitaria } from '@/lib/custo/custoCanonico';
import { fetchAllPages } from '@/lib/postgrest';

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
  estoque: number | null; // Stock quantity from omie_products
  status: 'pendente' | 'ofertado' | 'aceito' | 'rejeitado' | 'expirado';
}

export interface CustomerRecommendations {
  customerId: string;
  customerName: string;
  healthScore: number;
  crossSell: Recommendation[];
  upSell: Recommendation[];
}

// ─── Row types ─────────────────────────────────────────────────────
interface ClientScoreRow {
  customer_user_id: string;
  health_score: number | string | null;
  answer_rate_60d: number | string | null;
  whatsapp_reply_rate_60d: number | string | null;
}

interface ProductRow {
  id: string;
  codigo: string | null;
  descricao: string;
  valor_unitario: number | string | null;
  metadata: unknown;
  ativo: boolean | null;
  omie_codigo_produto: number | string | null;
  estoque: number | null;
}

interface ProductCostRow {
  product_id: string;
  cost_final: number | string | null;
  cost_price: number | string | null;
}

interface SalesOrderItem {
  product_id?: string;
  omie_codigo_produto?: number | string;
  quantity?: number | string;
  quantidade?: number | string;
  unit_price?: number | string;
  valor_unitario?: number | string;
}

interface SalesOrderRow {
  customer_user_id: string;
  items: SalesOrderItem[] | unknown;
  total: number | string | null;
  created_at: string;
}

interface AssocRuleRow {
  antecedent_product_ids: string[] | null;
  consequent_product_ids: string[] | null;
  confidence: number | string | null;
  lift: number | string | null;
  support: number | string | null;
}

interface ProfileRow {
  user_id: string;
  name: string | null;
  customer_type: string | null;
  cnae: string | null;
}

// ─── Premissas do LIE (NÃO são aprendidas) ───────────────────────────
// Constantes ARBITRADAS, não medições. Até 2026-07-21 o hook lia
// `farmer_category_conversion` e caía nestes mesmos valores quando não achava a
// linha — o que sugeria um "aprendizado histórico por categoria" que nunca
// existiu: a tabela tem 0 linhas desde que nasceu (fev/2026, `n_tup_ins = 0`),
// porque o único writer ficava atrás de `markAsAccepted`, que nenhuma UI jamais
// chamou. As 3.659 linhas de `farmer_recommendations` seguem 100% `pendente`,
// sem um único desfecho registrado. Ler a tabela vazia era teatro: quem decidia
// era sempre o default.
//
// Como são idênticas para TODO produto, funcionam como fator de ESCALA do LIE: o
// RANKING não depende delas (0,15·X vs 0,15·Y ordena igual a X vs Y). O que elas
// contaminam é o VALOR ABSOLUTO em R$ exibido na tela — que por isso é rotulado
// como estimativa não calibrada. Para virarem dado de verdade é preciso o loop de
// feedback inteiro (UI de desfecho + margem realizada + tempo gasto):
// ver docs/historico/farmer-aprendizado-conversao.md.
const TAXA_CONVERSAO_CROSS_SELL = 0.15;
const TAXA_CONVERSAO_UP_SELL = 0.10;
const FATOR_COMPLEXIDADE = 1.0;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Main Hook ───────────────────────────────────────────────────────
export const useCrossSellEngine = () => {
  // Lente "Ver como": id efetivo = ALVO na lente (lê/recalcula as recomendações DELE
  // pra inspeção), próprio usuário fora. Na lente a persistência é PULADA (igual
  // useFarmerScoring): o master inspeciona, não regrava a carteira do alvo. Fora da
  // lente effectiveUserId === user.id (byte-equivalente, zero regressão).
  const { effectiveUserId, isImpersonating } = useImpersonation();
  const [recommendations, setRecommendations] = useState<CustomerRecommendations[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);

  const calculateRecommendations = useCallback(async () => {
    if (!effectiveUserId) return;
    setCalculating(true);
    setLoading(true);

    try {
      // 1. Load client scores with pagination. Era um loop MANUAL com o mesmo defeito que o
      // #1545 tirou do `fetchAllPages` — mas por não CHAMAR o helper, ficou de fora daquele
      // grep: descartava o `error` (`const { data } = await q`), tratava `data: null` como fim
      // da tabela e não pedia `.order()`, então a ordem entre páginas era indefinida (o
      // Postgres pode repetir e pular linha). `customer_user_id` é UNIQUE na tabela.
      //
      // Aqui a página perdida era pior que um total truncado: o caller abaixo interpreta lista
      // vazia como "este farmer não tem carteira, deve ser super_admin" e RECARREGA SEM FILTRO
      // de farmer_id — uma falha de transporte trocava o escopo do cálculo.
      const fetchAllScores = (filterFarmerId?: string): Promise<ClientScoreRow[]> =>
        fetchAllPages<ClientScoreRow>(
          (de, ate) => {
            let q = supabase.from('farmer_client_scores').select('*');
            if (filterFarmerId) q = q.eq('farmer_id', filterFarmerId);
            return q.order('customer_user_id', { ascending: true }).range(de, ate) as unknown as
              PromiseLike<{ data: ClientScoreRow[] | null; error: unknown }>;
          },
          'farmer_client_scores/cross-sell',
        );

      // Try farmer-specific first, fallback to all (for super_admin). Na lente NÃO cai
      // no fallback de "todos os scores" — escopa estritamente ao alvo (degradação
      // honesta: alvo sem score → lista vazia, nunca a carteira de todo mundo).
      let clientScores = await fetchAllScores(effectiveUserId);
      if (!clientScores.length && !isImpersonating) {
        clientScores = await fetchAllScores();
      }

      if (!clientScores?.length) {
        setRecommendations([]);
        return;
      }

      // 2. Load all products with costs. AMBAS paginadas: 3.108 SKUs ativos e 3.637 linhas de
      // custo, contra a capa de 1.000 do PostgREST. Truncado, o costMap lia 72% do catálogo
      // como "sem custo" e o productList nunca chegava a recomendar 2/3 dos SKUs.
      const products = await fetchAllPages<ProductRow>((de, ate) =>
        supabase
          .from('omie_products')
          .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto, estoque')
          .eq('ativo', true)
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null; error: unknown }>,
        'omie_products/cross-sell',
      );

      const productCosts = await fetchAllPages<ProductCostRow>((de, ate) =>
        supabase
          .from('product_costs')
          .select('product_id, cost_final, cost_price')
          .order('product_id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ProductCostRow[] | null; error: unknown }>,
        'product_costs/cross-sell',
      );

      const costMap = new Map<string, number>();
      // Custo canônico = cost_final (proxy-aware); cost_price agora é nullable (só custo real).
      // Number(null)===0 inflava a margem (ausente≠zero) — excluir SKU sem custo, não fabricar 0.
      productCosts.forEach((pc) => {
        const c = custoCanonico(pc);
        if (c != null) costMap.set(pc.product_id, c);
      });

      // 3. Load ALL sales history (avoid huge .in() URL with 3598 IDs)
      // Mesmo defeito do loop manual acima — e aqui a perda é do HISTÓRICO que alimenta as
      // regras de associação: menos pedidos = menos coocorrência = recomendação mais pobre,
      // sem nada na tela indicando que o universo encolheu. `.order('id')` (PK) é a ordem
      // estável; a coluna não precisa estar no `select`.
      const salesOrders = await fetchAllPages<SalesOrderRow>(
        (de, ate) =>
          supabase
            .from('sales_orders')
            .select('customer_user_id, items, total, created_at')
            .in('status', ['confirmado', 'faturado', 'entregue'])
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: SalesOrderRow[] | null; error: unknown }>,
        'sales_orders/cross-sell',
      );

      // Build set of customer IDs that have orders
      const customerIdsWithOrders = new Set<string>();
      (salesOrders || []).forEach((o) => customerIdsWithOrders.add(o.customer_user_id));

      // Filter clientScores to only those with orders (avoid processing 3598 empty clients)
      const activeClientScores = clientScores.filter((c) => customerIdsWithOrders.has(c.customer_user_id));
      const customerIds = activeClientScores.map((c) => c.customer_user_id);

      if (!customerIds.length) {
        setRecommendations([]);
        return;
      }

      // 4. Load association rules for personalized recommendations
      const { data: assocRules } = (await supabase
        .from('farmer_association_rules')
        .select('antecedent_product_ids, consequent_product_ids, confidence, lift, support')
        .gte('confidence', 0.05)
        .gte('lift', 1.0)) as unknown as { data: AssocRuleRow[] | null };

      // Build map: antecedent product -> consequent products with scores
      const assocMap = new Map<string, { productId: string; confidence: number; lift: number; support: number }[]>();
      for (const rule of assocRules || []) {
        for (const ant of rule.antecedent_product_ids || []) {
          if (!assocMap.has(ant)) assocMap.set(ant, []);
          for (const cons of rule.consequent_product_ids || []) {
            assocMap.get(ant)!.push({
              productId: cons,
              confidence: Number(rule.confidence),
              lift: Number(rule.lift),
              support: Number(rule.support),
            });
          }
        }
      }

      // 5. Load customer profiles for active clients only
      // Split into batches of 100 (URL-limit safety) e dispara TODAS em paralelo.
      // Antes era sequencial: com 3598 clientes ativos = 36 roundtrips serial = 5–15s
      // bloqueando a thread de cálculo. Promise.all → 1 RTT efetivo (Supabase paraleliza).
      const batches: string[][] = [];
      for (let i = 0; i < customerIds.length; i += 100) {
        batches.push(customerIds.slice(i, i + 100));
      }
      const batchResults = await Promise.all(
        batches.map((batch) =>
          supabase
            .from('profiles')
            .select('user_id, name, customer_type, cnae')
            .in('user_id', batch) as unknown as Promise<{ data: ProfileRow[] | null }>,
        ),
      );
      const allProfiles: ProfileRow[] = batchResults.flatMap((r) => r.data || []);
      const profileMap = new Map<string, ProfileRow>();
      allProfiles.forEach((p) => profileMap.set(p.user_id, p));

      // 6. Build omie_codigo_produto -> product UUID map
      const omieToProductId = new Map<number, string>();
      (products || []).forEach((p) => {
        if (p.omie_codigo_produto) omieToProductId.set(Number(p.omie_codigo_produto), p.id);
      });

      // 7. Build per-customer purchase history
      // cost: number | null — null = custo DESCONHECIDO (SKU fora do costMap), nunca 0.
      const customerProducts = new Map<string, Map<string, { qty: number; price: number; cost: number | null }>>();
      const allProductPurchases = new Map<string, number>(); // product_id -> total customers who bought

      for (const order of salesOrders || []) {
        const cid = order.customer_user_id;
        if (!customerProducts.has(cid)) customerProducts.set(cid, new Map());
        const cp = customerProducts.get(cid)!;

        const items: SalesOrderItem[] = Array.isArray(order.items) ? (order.items as SalesOrderItem[]) : [];
        for (const item of items) {
          // Resolve product_id: use direct product_id or map from omie_codigo_produto
          let productId = item.product_id;
          if (!productId && item.omie_codigo_produto) {
            productId = omieToProductId.get(Number(item.omie_codigo_produto));
          }
          if (!productId) continue;

          const existing = cp.get(productId) || { qty: 0, price: 0, cost: null as number | null };
          existing.qty += Number(item.quantity || item.quantidade || 1);
          existing.price = Number(item.unit_price || item.valor_unitario || 0);
          // Custo ausente fica null (ausente≠zero) — com `|| 0` a margem do item virava o preço
          // cheio e distorcia a comparação de rentabilidade do up-sell logo abaixo.
          existing.cost = costMap.get(productId) ?? null;
          cp.set(productId, existing);

          // Track which products are popular
          if (!allProductPurchases.has(productId)) allProductPurchases.set(productId, 0);
          allProductPurchases.set(productId, allProductPurchases.get(productId)! + 1);
        }
      }

      const totalCustomers = Math.max(customerIds.length, 1);
      const productList = products || [];

      // 7. Calculate recommendations per client
      const allRecs: CustomerRecommendations[] = [];

      for (const score of activeClientScores) {
        const cid = score.customer_user_id;
        const profile = profileMap.get(cid);
        if (!profile) continue;

        const healthScore = Math.max(Number(score.health_score || 0), 10); // min 10 to avoid zero
        const customerPurchased = customerProducts.get(cid) || new Map();
        const purchasedIds = new Set(customerPurchased.keys());

        // Engagement factor: based on answer rate and responsiveness
        const answerRate = Number(score.answer_rate_60d || 0) / 100;
        const whatsappRate = Number(score.whatsapp_reply_rate_60d || 0) / 100;
        const engagementFactor = clamp(0.3 + 0.5 * answerRate + 0.2 * whatsappRate, 0.1, 1.0);

        const crossSellRecs: Recommendation[] = [];
        const upSellRecs: Recommendation[] = [];

        // ─── CROSS-SELL: Products not purchased, personalized by association rules ───
        // Build association boost map for this customer's purchased products
        const assocBoostMap = new Map<string, number>(); // productId -> max association score
        for (const purchasedId of purchasedIds) {
          const rules = assocMap.get(purchasedId);
          if (!rules) continue;
          for (const rule of rules) {
            if (purchasedIds.has(rule.productId)) continue; // already bought
            const assocScore = rule.confidence * Math.min(rule.lift, 5) / 5; // normalize lift
            const current = assocBoostMap.get(rule.productId) || 0;
            assocBoostMap.set(rule.productId, Math.max(current, assocScore));
          }
        }

        for (const product of productList) {
          if (purchasedIds.has(product.id)) continue;

          const price = Number(product.valor_unitario || 0);
          // Sem custo conhecido a margem é INDEFINIDA, não cheia: o SKU sai do ranking. Com
          // `|| 0` ele ganhava margem 100% e, como o único filtro é `margin <= 0`, era o único
          // que jamais era excluído — o LIE passava a preferir o produto sem custo cadastrado.
          const margin = margemUnitaria(price, costMap.get(product.id));
          if (margin == null || margin <= 0) continue; // custo desconhecido, ou margem não-positiva

          // Cluster adherence: how many similar customers bought this
          const buyerCount = allProductPurchases.get(product.id) || 0;
          const clusterAdherence = clamp(buyerCount / totalCustomers, 0, 1);

          // Association boost: personalized score based on what THIS customer bought
          const assocBoost = assocBoostMap.get(product.id) || 0;

          // Skip if neither popular in cluster nor associated with customer's basket
          if (clusterAdherence < 0.03 && assocBoost === 0) continue;

          // Historical conversion rate for this product
          // P_ij = TaxaArbitrada × (HealthScore/100) × Engagement × (ClusterAdherence + AssocBoost)
          const relevance = clamp(clusterAdherence * 0.4 + assocBoost * 0.6, 0.01, 1.0);
          const pij = TAXA_CONVERSAO_CROSS_SELL * (healthScore / 100) * engagementFactor * relevance;

          // M_ij = Margin × EstimatedClusterVolume
          const clusterVolume = Math.max(1, Math.round(buyerCount / totalCustomers * 12)); // monthly estimate
          const mij = margin * clusterVolume;

          // LIE_ij = P_ij × M_ij × FatorComplexidade (constante — ver bloco de premissas)
          const complexityFactor = FATOR_COMPLEXIDADE;
          const lie = pij * mij * complexityFactor;

          if (lie > 0) {
            crossSellRecs.push({
              customerId: cid,
              customerName: profile.name ?? '',
              type: 'cross_sell',
              productId: product.id,
              productName: product.descricao,
              pij: Math.round(pij * 1000) / 10,
              mij: Math.round(mij * 100) / 100,
              lie: Math.round(lie * 100) / 100,
              complexityFactor,
              clusterVolume,
              estoque: product.estoque ?? null,
              status: 'pendente',
            });
          }
        }

        // ─── UP-SELL: Find premium alternatives for current low-margin products ───
        for (const [purchasedId, purchaseData] of customerPurchased.entries()) {
          // Custo do item comprado desconhecido → não dá para afirmar que a margem atual é ruim;
          // o produto sai do up-sell em vez de ser tratado como margem cheia.
          const currentMargin = margemUnitaria(purchaseData.price, purchaseData.cost);
          if (currentMargin == null || currentMargin <= 0 || purchaseData.price <= 0) continue;
          const currentMarginPct = currentMargin / purchaseData.price;
          if (currentMarginPct > 0.35) continue; // Already good margin, skip

          // Find premium alternatives (higher price, higher margin)
          for (const product of productList) {
            if (product.id === purchasedId) continue;
            if (purchasedIds.has(product.id)) continue;

            const premiumPrice = Number(product.valor_unitario || 0);
            const premiumMargin = margemUnitaria(premiumPrice, costMap.get(product.id));
            // Sem custo não há como PROVAR que a alternativa é mais rentável — fora do up-sell
            // (com `|| 0` ela aparentava a maior margem possível e vencia a comparação abaixo).
            if (premiumMargin == null) continue;

            // Must be genuinely premium: higher price AND higher margin
            if (premiumPrice <= purchaseData.price * 1.1) continue;
            if (premiumMargin <= currentMargin * 1.2) continue;

            // P_ij for up-sell
            const pij = TAXA_CONVERSAO_UP_SELL * (healthScore / 100) * engagementFactor * 0.8; // 0.8 = up-sell is harder

            // M_ij = (PremiumMargin - CurrentMargin) × CurrentVolume
            const mij = (premiumMargin - currentMargin) * purchaseData.qty;

            const complexityFactor = FATOR_COMPLEXIDADE;
            const lie = pij * mij * complexityFactor;

            if (lie > 0) {
              const currentProduct = productList.find((p) => p.id === purchasedId);
              upSellRecs.push({
                customerId: cid,
                customerName: profile.name ?? '',
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
                estoque: product.estoque ?? null,
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
            customerName: profile.name ?? '',
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

      // Persist recommendations (batch upsert único — antes era N×M serial)
      const recRows = allRecs.flatMap((cr) =>
        [...cr.crossSell, ...cr.upSell].map((rec) => ({
          farmer_id: effectiveUserId,
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
        })),
      );
      // Persistência PULADA na lente "Ver como" (somente leitura: o master inspeciona
      // as recomendações do alvo sem regravar a carteira dele).
      if (!isImpersonating && recRows.length > 0) {
        await supabase.from('farmer_recommendations').upsert(recRows);
      }
    } catch (error) {
      console.error('Error calculating recommendations:', error);
    } finally {
      setCalculating(false);
      setLoading(false);
    }
  }, [effectiveUserId, isImpersonating]);

  // ─── Actions ─────────────────────────────────────────────────────────
  // `markAsOffered` / `markAsAccepted` / `markAsRejected` e o `updateConversionStats`
  // que gravava `farmer_category_conversion` foram removidos em 2026-07-21: nenhum
  // componente os importava (só `calculateRecommendations` era consumido), então o
  // desfecho de uma recomendação nunca chegou a ser registrado — daí as 3.659 linhas
  // 100% `pendente`. Construir o loop de feedback é decisão de produto e exige mais
  // que estes métodos (UI de desfecho, margem realizada, `onConflict` correto no
  // upsert). Desenho preservado em docs/historico/farmer-aprendizado-conversao.md.

  return {
    recommendations,
    loading,
    calculating,
    calculateRecommendations,
  };
};
