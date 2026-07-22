import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
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
  pij: number;          // Probabilidade de conversão (0–100, já em %)
  /**
   * Score de AFINIDADE — adimensional, NÃO é dinheiro. Ordena a lista; não promete lucro.
   *
   * Era `lie` ("Expected Incremental Profit"), = pij × mij × complexityFactor, com
   * `mij = margem × volume`. Sem custo no browser não há margem, então o produto todo caiu.
   * Hoje é `pij` puro. Duas razões para NÃO remultiplicar por complexityFactor (rodada 3 do
   * Codex): (1) a fórmula em updateConversionStats é invertida — maior lucro/hora produz fator
   * MENOR, e multiplicar penalizaria justamente o que é fácil de vender; (2)
   * `farmer_category_conversion` é global e o browser faz upsert direto nela, então um employee
   * poderia escrever `complexity_factor` arbitrário e escolher o próprio ranking. Recolocar um
   * fator de facilidade exige antes torná-lo server-owned, finito e limitado.
   *
   * ⚠️ Nunca formatar como R$. `clusterVolume` também ficou FORA: ele já entra em `pij` via
   * `relevance`, e multiplicar de novo favoreceria produto popular contra associação de nicho —
   * que é o único sinal personalizado por cliente.
   */
  affinityScore: number;
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

interface ConversionRow {
  category_id: string;
  conversion_rate: number | string | null;
  complexity_factor: number | string | null;
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

interface RecommendationStatsRow {
  status: string;
  actual_margin: number | string | null;
  time_spent_seconds: number | null;
}

interface RecommendationUpdate {
  status: 'aceito';
  accepted_at: string;
  actual_margin?: number;
  time_spent_seconds?: number;
}

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
      // 1. Load client scores with pagination
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

      // 2. Catálogo ativo, paginado (3.108 SKUs contra a capa de 1.000 do PostgREST).
      const products = await fetchAllPages<ProductRow>((de, ate) =>
        supabase
          .from('omie_products')
          .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto, estoque')
          .eq('ativo', true)
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null }>,
      );

      // 2b. Quais SKUs são VENDÁVEIS (margem canônica > 0). O browser não vê mais custo:
      // `public.get_skus_margem_positiva()` responde só o conjunto, sem parâmetro e sem ordem
      // (a versão que recebia pesos e devolvia ranking era régua graduada — ver o cabeçalho da
      // migration 20260725120000). SKU sem custo conhecido não entra: ausente≠zero (#1466).
      //
      // FAIL-CLOSED: falha na RPC → NÃO recomenda. Degradar para "recomenda tudo" poria produto
      // de PREJUÍZO no topo da lista da vendedora, que é o pior desfecho possível aqui.
      const { data: skusVendaveis, error: erroVendaveis } = (await supabase.rpc(
        'get_skus_margem_positiva',
      )) as unknown as { data: { product_id: string }[] | null; error: unknown };
      if (erroVendaveis || !skusVendaveis) {
        console.error('get_skus_margem_positiva falhou — sem recomendação (fail-closed):', erroVendaveis);
        setRecommendations([]);
        return;
      }
      const vendaveis = new Set(skusVendaveis.map((r) => r.product_id));

      // 3. Load ALL sales history (avoid huge .in() URL with 3598 IDs)
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

      // 4. Load category conversion rates (learning data)
      const { data: conversionData } = (await supabase
        .from('farmer_category_conversion')
        .select('*')) as unknown as { data: ConversionRow[] | null };
      const conversionMap = new Map<string, ConversionRow>();
      (conversionData || []).forEach((c) => conversionMap.set(c.category_id, c));

      // 4b. Load association rules for personalized recommendations
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

      // 7. Build per-customer purchase history. Sem `cost`: o custo não chega mais ao browser.
      const customerProducts = new Map<string, Map<string, { qty: number; price: number }>>();
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

          const existing = cp.get(productId) || { qty: 0, price: 0 };
          existing.qty += Number(item.quantity || item.quantidade || 1);
          existing.price = Number(item.unit_price || item.valor_unitario || 0);
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

          // O custo decide EXCLUSÃO, nunca ORDEM: o SKU só entra se a RPC o listou como vendável
          // (margem canônica > 0). Custo desconhecido não entra — ausente≠zero (#1466).
          if (!vendaveis.has(product.id)) continue;

          // Cluster adherence: how many similar customers bought this
          const buyerCount = allProductPurchases.get(product.id) || 0;
          const clusterAdherence = clamp(buyerCount / totalCustomers, 0, 1);

          // Association boost: personalized score based on what THIS customer bought
          const assocBoost = assocBoostMap.get(product.id) || 0;

          // Skip if neither popular in cluster nor associated with customer's basket
          if (clusterAdherence < 0.03 && assocBoost === 0) continue;

          // Historical conversion rate for this product
          const conv = conversionMap.get(product.id);
          const historicalRate = conv ? Number(conv.conversion_rate) : 0.15; // default 15%

          // P_ij = HistoricalRate × (HealthScore/100) × Engagement × (ClusterAdherence + AssocBoost)
          const relevance = clamp(clusterAdherence * 0.4 + assocBoost * 0.6, 0.01, 1.0);
          const pij = historicalRate * (healthScore / 100) * engagementFactor * relevance;

          // Estimativa de volume do cluster: preservada como CONTEXTO da recomendação, mas fora
          // do score (ela já entra em `pij` via `relevance` — remultiplicar afogaria o assocBoost).
          const clusterVolume = Math.max(1, Math.round(buyerCount / totalCustomers * 12));

          // Fator de complexidade: guardado como dado aprendido, NÃO multiplica o score.
          // Ver o comentário de `affinityScore` no tipo (fórmula invertida + tabela escrivível
          // por employee, o que deixaria a própria vendedora escolher o ranking).
          const complexityFactor = conv ? Number(conv.complexity_factor) : 1.0;

          // Afinidade pura. Sem custo não existe "lucro esperado" — existe "próxima melhor oferta".
          const affinityScore = pij;

          if (affinityScore > 0) {
            crossSellRecs.push({
              customerId: cid,
              customerName: profile.name ?? '',
              type: 'cross_sell',
              productId: product.id,
              productName: product.descricao,
              pij: Math.round(pij * 1000) / 10,
              affinityScore: Math.round(affinityScore * 10000) / 10000,
              complexityFactor,
              clusterVolume,
              estoque: product.estoque ?? null,
              status: 'pendente',
            });
          }
        }

        // ─── UP-SELL: Find premium alternatives for current low-margin products ───
        for (const [purchasedId, purchaseData] of customerPurchased.entries()) {
          if (purchaseData.price <= 0) continue;

          // Alternativas PREMIUM = preço materialmente maior e SKU vendável.
          //
          // Os dois testes de margem que existiam aqui ("margem atual < 35%" e "margem premium
          // > 120% da atual") não sobrevivem à saída do custo: `get_skus_margem_positiva()`
          // responde "este SKU é vendável?", não compara a rentabilidade de DOIS SKUs. O up-sell
          // deixa de PROMETER margem melhor e passa a sugerir a linha superior — degradação
          // honesta, e é a que o parecer do Codex (rodada 3) considerou aceitável. Recuperar a
          // comparação exige uma RPC própria que devolva a ordem já pronta do servidor.
          for (const product of productList) {
            if (product.id === purchasedId) continue;
            if (purchasedIds.has(product.id)) continue;
            if (!vendaveis.has(product.id)) continue;

            const premiumPrice = Number(product.valor_unitario || 0);
            if (premiumPrice <= purchaseData.price * 1.1) continue;

            const conv = conversionMap.get(product.id);
            const historicalRate = conv ? Number(conv.conversion_rate) : 0.10;

            // P_ij for up-sell
            const pij = historicalRate * (healthScore / 100) * engagementFactor * 0.8; // 0.8 = up-sell is harder

            const complexityFactor = conv ? Number(conv.complexity_factor) : 1.0;
            const affinityScore = pij;

            if (affinityScore > 0) {
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
                affinityScore: Math.round(affinityScore * 10000) / 10000,
                complexityFactor,
                clusterVolume: purchaseData.qty,
                estoque: product.estoque ?? null,
                status: 'pendente',
              });
            }
          }
        }

        // Ordena por AFINIDADE (desc), top 3 cross-sell e top 2 up-sell
        crossSellRecs.sort((a, b) => b.affinityScore - a.affinityScore);
        upSellRecs.sort((a, b) => b.affinityScore - a.affinityScore);

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

      // Ordena clientes pela MELHOR afinidade da carteira, não pela soma.
      // Somar scores de cross-sell e up-sell tratava-os como valores comensuráveis — eles não
      // são (o `pij` do up-sell já carrega o fator 0,8 e sai de outra base histórica). A soma
      // também premiava quem tem MAIS itens na lista, não quem tem a melhor oferta.
      const melhorAfinidade = (c: CustomerRecommendations) =>
        Math.max(0, ...[...c.crossSell, ...c.upSell].map((r) => r.affinityScore));
      allRecs.sort((a, b) => melhorAfinidade(b) - melhorAfinidade(a));

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
          // m_ij explicitamente NULL, não omitido: o upsert do PostgREST só atualiza as colunas
          // presentes no payload, então OMITIR deixaria o valor antigo intacto nas linhas que
          // colidem — e `m_ij ÷ cluster_volume_estimate` devolve a margem unitária (conferido em
          // prod: 134,26/2 = 67,13). A limpeza das linhas que NÃO colidem é a migration
          // 20260725123000.
          m_ij: null,
          // A coluna `lie` passa a guardar o score de AFINIDADE (adimensional). Mantida populada
          // porque vários consumidores ordenam por ela (usePropostaPreview, lib/whatsapp/cross-sell,
          // useBundleEngine.bestIndividual) — ordenar por afinidade é o comportamento desejado.
          // O valor ANTIGO invertia sozinho: m_ij ≈ lie / ((p_ij/100) × complexity_factor).
          lie: rec.affinityScore,
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
  const markAsOffered = useCallback(async (recId: string) => {
    await supabase.from('farmer_recommendations')
      .update({ status: 'ofertado', offered_at: new Date().toISOString() })
      .eq('id', recId);
  }, []);

  const markAsAccepted = useCallback(async (recId: string, actualMargin?: number, timeSpent?: number) => {
    const update: RecommendationUpdate = {
      status: 'aceito',
      accepted_at: new Date().toISOString(),
    };
    if (actualMargin !== undefined) update.actual_margin = actualMargin;
    if (timeSpent !== undefined) update.time_spent_seconds = timeSpent;

    await supabase.from('farmer_recommendations').update(update).eq('id', recId);

    // Update category conversion rates (learning)
    if (actualMargin !== undefined) {
      const { data: rec } = (await supabase.from('farmer_recommendations')
        .select('product_id').eq('id', recId).single()) as unknown as { data: { product_id: string } | null };
      if (rec) {
        await updateConversionStats(rec.product_id);
      }
    }
  }, []);

  const markAsRejected = useCallback(async (recId: string) => {
    await supabase.from('farmer_recommendations')
      .update({ status: 'rejeitado', rejected_at: new Date().toISOString() })
      .eq('id', recId);
  }, []);

  // Recalculate conversion stats from historical data
  const updateConversionStats = async (productId: string) => {
    const { data: recs } = (await supabase.from('farmer_recommendations')
      .select('status, actual_margin, time_spent_seconds')
      .eq('product_id', productId)
      .in('status', ['aceito', 'rejeitado', 'ofertado'])) as unknown as { data: RecommendationStatsRow[] | null };

    if (!recs?.length) return;

    const offered = recs.filter((r) => ['aceito', 'rejeitado', 'ofertado'].includes(r.status)).length;
    const accepted = recs.filter((r) => r.status === 'aceito').length;
    const rate = offered > 0 ? accepted / offered : 0;

    const acceptedRecs = recs.filter((r) => r.status === 'aceito' && r.actual_margin != null);
    const avgMargin = acceptedRecs.length > 0
      ? acceptedRecs.reduce((s, r) => s + Number(r.actual_margin), 0) / acceptedRecs.length
      : 0;

    const withTime = acceptedRecs.filter((r): r is RecommendationStatsRow & { time_spent_seconds: number } => r.time_spent_seconds != null);
    const avgTime = withTime.length > 0
      ? Math.round(withTime.reduce((s, r) => s + r.time_spent_seconds, 0) / withTime.length)
      : 0;

    const profitPerHour = avgTime > 0 ? (avgMargin / (avgTime / 3600)) : 0;

    // Complexity factor: higher profit/hour = lower complexity (easier to sell)
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
    recommendations,
    loading,
    calculating,
    calculateRecommendations,
    markAsOffered,
    markAsAccepted,
    markAsRejected,
  };
};
