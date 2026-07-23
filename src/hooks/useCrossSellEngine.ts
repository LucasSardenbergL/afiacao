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
   * Era `lie` ("Expected Incremental Profit") = pij × mij × complexityFactor, com
   * `mij = margem × volume`. Sem custo no browser não há margem, e o produto todo caiu junto.
   *
   * Hoje é `pij` puro. `complexityFactor` fica fora porque desde o #1514 ele é a CONSTANTE
   * `FATOR_COMPLEXIDADE = 1.0` — igual para todo candidato, logo incapaz de mudar ORDEM.
   * (Antes de #1514 ele vinha de `farmer_category_conversion`, e aí havia motivo mais forte
   * ainda: a tabela é global e o browser faz upsert direto nela, então um employee escrevia o
   * fator e escolhia o próprio ranking. Se um dia voltar a ser aprendido, precisa nascer
   * server-owned, finito e limitado — e com a fórmula corrigida: a de updateConversionStats é
   * invertida, maior lucro/hora produz fator MENOR.)
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

      // 2. Catálogo ativo, paginado (3.108 SKUs contra a capa de 1.000 do PostgREST).
      const products = await fetchAllPages<ProductRow>((de, ate) =>
        supabase
          .from('omie_products')
          .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto, estoque')
          .eq('ativo', true)
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null; error: unknown }>,
        'omie_products/cross-sell',
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
          // P_ij = TaxaArbitrada × (HealthScore/100) × Engagement × (ClusterAdherence + AssocBoost)
          const relevance = clamp(clusterAdherence * 0.4 + assocBoost * 0.6, 0.01, 1.0);
          const pij = TAXA_CONVERSAO_CROSS_SELL * (healthScore / 100) * engagementFactor * relevance;

          // Estimativa de volume do cluster: preservada como CONTEXTO da recomendação, mas fora
          // do score (ela já entra em `pij` via `relevance` — remultiplicar afogaria o assocBoost).
          const clusterVolume = Math.max(1, Math.round(buyerCount / totalCustomers * 12));

          // Constante desde o #1514 (ver bloco de premissas). Persistida como dado, mas NÃO
          // multiplica o score: sendo 1.0 e igual para todo candidato, ela não muda ORDEM.
          const complexityFactor = FATOR_COMPLEXIDADE;

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

            // P_ij for up-sell
            const pij = TAXA_CONVERSAO_UP_SELL * (healthScore / 100) * engagementFactor * 0.8; // 0.8 = up-sell is harder

            const complexityFactor = FATOR_COMPLEXIDADE;
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
