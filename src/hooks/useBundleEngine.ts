import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';
import { margemConhecida } from '@/lib/scoring/margin';
import { fetchAllPages } from '@/lib/postgrest';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import {
  avaliarCompletude,
  INSUMOS_OBRIGATORIOS_BUNDLE,
  type InsumosSnapshot,
} from '@/lib/farmer/completude-snapshot';
import { lerHeadVigente, registrarGeracaoFarmer } from '@/lib/farmer/registrar-geracao';

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
  /**
   * Score de AFINIDADE (adimensional) da melhor recomendação individual — NÃO é dinheiro.
   * Era `lie: number` lendo `farmer_recommendations.lie`, que agora é sempre NULL: `Number(null)`
   * daria 0 e fabricaria "nenhuma afinidade" onde o certo é "não medida" (money-path §2).
   */
  affinity: number | null;
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
  affinity_score: number | string | null;
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

    // Snapshot dos insumos DESTA execução (ver useCrossSellEngine para o racional): o head
    // precisa declarar se o zero veio de um snapshot íntegro, e isso não se infere do
    // resultado — só o produtor sabe.
    const insumos: InsumosSnapshot = {};
    // `undefined` = não consegui ler o head → registro PULADO, nunca às cegas.
    let headVisto: string | null | undefined;
    const runId = crypto.randomUUID();

    const registrarVazio = async () => {
      if (isImpersonating || headVisto === undefined) return;
      const { completude, motivo } = avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_BUNDLE);
      await registrarGeracaoFarmer({
        motor: 'bundle',
        farmerId: effectiveUserId,
        runId,
        resultado: 'vazio',
        linhasGeradas: 0,
        completude,
        motivo,
        insumos,
        headVisto,
      });
    };

    try {
      // 0. Identidade desta EXECUÇÃO + a geração de bundles que ela substitui.
      // Lido ANTES do snapshot (money-path §10: reivindicar depois deixa a corrida
      // aberta pela porta de trás). Espelha useCrossSellEngine — ver o racional lá.
      let geracaoVista: string | null = null;
      if (!isImpersonating) {
        headVisto = await lerHeadVigente('bundle', effectiveUserId);
        // Mesma ordem que a RPC usa para eleger a geração vigente (created_at desc, id desc).
        const { data: vigente, error: erroVigente } = await supabase
          .from('farmer_bundle_recommendations')
          .select('run_id')
          .eq('farmer_id', effectiveUserId)
          .eq('status', 'pendente')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        if (erroVigente) {
          throw new Error(
            mensagemDeErro(erroVigente) ??
              'Não consegui ler a geração vigente de bundles — nada foi recalculado.',
          );
        }
        geracaoVista = vigente?.[0]?.run_id ?? null;
      }

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
        //
        // PAGINADA como as duas leituras acima: a RPC devolve 2.462 linhas em prod e vinha
        // capada nas 1.000 do PostgREST, então todo SKU vendável da cauda era tratado como
        // NÃO-vendável pelo gate lá embaixo. Isso não encolhia a oferta, CONGELAVA a tabela:
        // sem um PAR de consequentes vendáveis o lote sai vazio, e lote vazio pula a RPC de
        // gravação de propósito — nenhuma escrita, nenhum erro, nenhum toast. Era o único
        // insumo do engine fora do `fetchAllPages` (#1520 criou a RPC; a correção do
        // truncamento silencioso de `omie_products`/`profiles` não a alcançou).
        //
        // A rejeição vira `{ data: null, error }` para PRESERVAR o fail-closed explícito
        // abaixo (`insumos.vendaveis.ok = false` + `registrarVazio()`): deixar `fetchAllPages`
        // lançar aqui trocaria esse desfecho registrado por um throw genérico, e o head
        // degradado passaria a poder autorizar expiração.
        fetchAllPages<{ product_id: string }>(
          (de, ate) =>
            supabase
              .rpc('get_skus_margem_positiva')
              // `.order` ESTÁVEL antes do `.range`: a função não tem `ORDER BY` (é um
              // `RETURN QUERY SELECT p.id FROM omie_products JOIN product_costs`), e paginar
              // sem ordem total deixa o plano decidir a ordem de cada página — o que PULA e
              // repete linhas entre elas. Repetir é inócuo (o destino é um Set); pular
              // reintroduziria em menor escala o próprio bug que este trecho corrige, e de
              // forma intermitente. `product_id` é a PK do catálogo: ordem total.
              .order('product_id', { ascending: true })
              .range(de, ate) as unknown as PromiseLike<{ data: { product_id: string }[] | null; error: unknown }>,
          'get_skus_margem_positiva/bundle',
        ).then(
          (data) => ({ data, error: null as unknown }),
          (error: unknown) => ({ data: null, error }),
        ),
      ]);

      // `fetchAllPages` LANÇA em falha de página, então chegar aqui já significa leitura
      // íntegra — `ok: true`. O que ainda pode ser zero é o CONTEÚDO.
      insumos.catalogo = { ok: true, n: (products || []).length };
      insumos.scores = { ok: true, n: clientScores.length };

      // FAIL-CLOSED: falha na RPC → NENHUM bundle. Degradar para "monta bundle com tudo" poria
      // produto de PREJUÍZO na oferta combinada, que é o pior desfecho possível aqui.
      if (vendaveisResult.error || !vendaveisResult.data) {
        console.error('get_skus_margem_positiva falhou — sem bundles (fail-closed):', vendaveisResult.error);
        // `ok: false` = "não consegui ler", não "veio vazio". Um head degradado por aqui
        // nunca poderá autorizar expiração.
        insumos.vendaveis = { ok: false, n: 0 };
        setCustomerBundles([]);
        await registrarVazio();
        return;
      }
      const vendaveis = new Set(vendaveisResult.data.map((r) => r.product_id));
      insumos.vendaveis = { ok: true, n: vendaveis.size };

      if (!clientScores?.length) {
        setCustomerBundles([]);
        // Era um `return` MUDO — a razão de a frequência do zero nunca ter sido mensurável.
        await registrarVazio();
        return;
      }

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

      // Dois insumos distintos: `pedidos` é global (a base tem histórico?) e
      // `carteira_ativa` é o universo REAL deste cálculo (a carteira DESTE farmer tem?).
      const clientesComPedido = new Set((salesOrders || []).map((o) => o.customer_user_id));
      insumos.pedidos = { ok: true, n: clientesComPedido.size };
      const ativos = clientScores.filter((c) => clientesComPedido.has(c.customer_user_id));
      insumos.carteira_ativa = { ok: true, n: ativos.length };
      // COBERTURA de perfil: o motor faz `if (!profile) continue` mais abaixo — cliente sem
      // perfil é pulado em silêncio (ver useCrossSellEngine para o racional completo).
      insumos.clientes_com_profile = {
        ok: true,
        n: ativos.filter((c) => profileMap.has(c.customer_user_id)).length,
      };

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

      // `regras` é insumo OBRIGATÓRIO do bundle (ver completude-snapshot): sem regra
      // descoberta não há `applicableRules`, e o motor produz zero por construção. Declara-se
      // o array INTEIRO — é ele que alimenta o filtro abaixo, não o top-50 que vai à tabela.
      insumos.regras = { ok: true, n: discoveredRules.length };

      // Persist top rules — PULADO na lente "Ver como" (a tabela é GLOBAL: a troca
      // substitui as regras de toda a base; o master inspeciona os bundles do alvo sem
      // recalcular regras/recomendações da carteira dele).
      //
      // Vai por RPC porque `delete()` + `insert()` são DUAS chamadas PostgREST, logo duas
      // transações: falha entre elas deixava a tabela VAZIA — e ela alimenta o MixGap
      // (`get_meu_mixgap`), o canal Melhorias (`melhoria_produtos_relacionados`), a edge
      // `recommend` (assoc_score) e o `useCrossSellEngine`. A RPC faz DELETE+INSERT numa
      // transação só: INSERT falho devolve as regras antigas. Provada em db/test-farmer-
      // association-rules-atomica.sh (26 asserts + 4 falsificações).
      let desfechoRegras: 'gravadas' | 'lente' | 'sem_regras' | 'falhou' = 'lente';
      if (!isImpersonating) {
        const regrasParaGravar = discoveredRules.slice(0, 50).map(r => ({
          antecedent_product_ids: r.antecedent,
          consequent_product_ids: r.consequent,
          support: Math.round(r.support * 10000) / 10000,
          confidence: Math.round(r.confidence * 10000) / 10000,
          lift: Math.round(r.lift * 100) / 100,
          rule_type: r.type,
          sample_size: totalBaskets,
        }));

        if (regrasParaGravar.length === 0) {
          // Zero regra descoberta quase sempre é dado faltando a montante, não "a base não
          // tem padrão" — e apagar por isso derruba quatro features. Preserva o que está lá.
          // (A RPC recusaria o lote vazio de qualquer jeito; não chamamos só pra tomar erro.)
          desfechoRegras = 'sem_regras';
        } else {
          const { error: erroRegras } = await supabase.rpc('farmer_association_rules_substituir', {
            p_regras: regrasParaGravar as unknown as Json,
          });
          // Sem `throw`: os bundles abaixo saem das regras em MEMÓRIA e continuam válidos.
          // Mas o toast final não pode dizer que deu tudo certo.
          if (erroRegras) {
            console.error('Falha ao substituir farmer_association_rules:', erroRegras);
            desfechoRegras = 'falhou';
          } else {
            desfechoRegras = 'gravadas';
          }
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
          .select('product_id, affinity_score, recommendation_type')
          .eq('farmer_id', effectiveUserId)
          .eq('customer_user_id', cid)
          .eq('status', 'pendente')
          // `.not(...is null)` é fail-closed: com todas as linhas antigas, ordenar não ordena nada
          // e o `.limit(1)` elegeria um "melhor individual" arbitrário. `nullsFirst: false` cobre
          // a MISTURA (DESC implica NULLS FIRST no Postgres); o filtro cobre o caso TODAS-NULL.
          .not('affinity_score', 'is', null)
          .order('affinity_score', { ascending: false, nullsFirst: false })
          // ⚠️ `created_at` deixou de desempatar: desde a migration 20260814223445 a geração
          // inteira entra num único INSERT, e `now()` é o instante da TRANSAÇÃO — todas as
          // linhas do run compartilham o mesmo carimbo. `id` é a PK: última chave, sempre
          // total (achado do challenge Codex xhigh).
          .order('updated_at', { ascending: false }) // desempate determinístico
          .order('id', { ascending: false })
          .limit(1)) as unknown as { data: ExistingRecRow[] | null };

        if (existingRecs?.length) {
          const rec = existingRecs[0];
          const prod = productMap.get(rec.product_id);
          // Ausente ≠ zero: `Number(null)` é 0 e afirmaria afinidade nula medida.
          const afinidade = rec.affinity_score == null ? NaN : Number(rec.affinity_score);
          bestIndividual = {
            productId: rec.product_id,
            productName: prod?.descricao || 'Produto',
            affinity: Number.isFinite(afinidade) ? afinidade : null,
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

      // Persist bundle recommendations — via RPC que SUBSTITUI a geração anterior.
      // PULADO na lente "Ver como" (só leitura: o master inspeciona os bundles do alvo
      // sem regravar a carteira dele).
      //
      // Era `.insert()` puro: cada recálculo EMPILHAVA uma geração nova sem aposentar a
      // anterior, e como `OfertaCruaCard`/`useTacticalPlan` leem `status='pendente'`
      // ordenado por `affinity_bundle` desc com `.limit(1)`/`.limit(2)`, um bundle ANTIGO
      // de score maior seguia sendo o topo indefinidamente. Ver o cabeçalho da migration
      // 20260814223445 para a medição.
      //
      // A RPC expira-e-insere numa transação só; em duas chamadas PostgREST seriam duas
      // transações, e falhar entre elas deixaria o farmer sem NENHUM bundle pendente.
      // `m_bundle`/`lie_bundle` saem do payload — a RPC os fixa em NULL.
      //
      // O `error` é CAPTURADO; sem `throw`, porque os bundles em memória continuam válidos
      // e já foram exibidos — só o toast final deixa de dizer que deu tudo certo.
      let recomendacoesNaoGravadas = 0;
      /** FG006: outro run JÁ gravou — a tabela tem algo mais NOVO que isto. */
      let geracaoPerdida = false;
      /** FG005: outro run está EM VOO — ninguém venceu ainda, e ele pode até dar rollback.
       *  Separado de propósito: dizer "as telas estão com o resultado dele" quando o
       *  concorrente ainda não commitou seria afirmar um desfecho que não existe, e o
       *  operador desistiria de tentar de novo (achado do challenge Codex xhigh). */
      let recalculoConcorrente = false;
      if (!isImpersonating) {
        const recomendacoes = allCustomerBundles.flatMap((cb) =>
          cb.bundles.map((bundle) => ({
            customer_user_id: bundle.customerId,
            // Sem `cost`/`margin` por SKU — o jsonb guardava o custo LITERAL (12/12 linhas em
            // prod). Só id/name/price, e `price` é público.
            bundle_products: bundle.products as unknown as Json,
            support: bundle.support,
            confidence: bundle.confidence,
            lift: bundle.lift,
            p_bundle: bundle.pBundle,
            affinity_bundle: bundle.affinityBundle,
            complexity_factor: bundle.complexityFactor,
          })),
        );

        // Lote vazio não chama a RPC (ela recusaria com FG003): expirar a geração por
        // "não achei bundle nenhum" tiraria a oferta da tela por um dado que falta a
        // montante. Mesmo critério das regras de associação logo acima.
        //
        // O que MUDOU: o vazio deixou de ser silencioso — ele move o HEAD declarando se o
        // snapshot estava íntegro. Vazio com snapshot completo é o "zero de verdade", e é
        // o único sinal que autorizaria a fase 2 a ligar a expiração.
        const { completude, motivo } = avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_BUNDLE);
        if (recomendacoes.length === 0) {
          await registrarVazio();
        }
        if (recomendacoes.length > 0) {
          const { error: erroRecs } = await supabase.rpc(
            'farmer_bundle_recomendacoes_substituir' as never,
            {
              p_farmer_id: effectiveUserId,
              p_run_id: runId,
              p_geracao_vista: geracaoVista,
              p_linhas: recomendacoes,
              // O head é movido pela própria RPC, na MESMA transação.
              p_completude: completude,
              p_motivo: motivo,
              p_insumos: insumos,
              // Ver useCrossSellEngine: sem o head ORIGINAL, um run vazio mais novo seria
              // sobrescrito por este, que leu snapshot mais velho.
              p_head_visto: headVisto ?? null,
            } as never,
          );
          if (erroRecs) {
            console.error('Falha ao substituir farmer_bundle_recommendations:', erroRecs);
            // FG006 = outro recálculo gravou no meio deste. A tabela ficou com algo MAIS
            // novo — dizer "não gravou, seguem as anteriores" inverteria o sentido.
            const codigo = (erroRecs as { code?: string } | null)?.code;
            if (codigo === 'FG006') {
              geracaoPerdida = true;
            } else if (codigo === 'FG005') {
              recalculoConcorrente = true;
            } else {
              recomendacoesNaoGravadas = recomendacoes.length;
            }
          }
        }
      }

      // O toast reflete o que REALMENTE aconteceu. Antes ele era `success` incondicional —
      // com a persistência falhando calada, o operador via "regras gravadas" e ia embora.
      // Regras e recomendações falham de forma INDEPENDENTE, então os dois desfechos entram
      // no mesmo aviso: reportar só um deixaria o outro invisível.
      const totalBundles = allCustomerBundles.reduce((s, c) => s + c.bundles.length, 0);
      const problemas: string[] = [];
      if (desfechoRegras === 'falhou') {
        problemas.push('as regras NÃO foram salvas — as anteriores seguem valendo');
      } else if (desfechoRegras === 'sem_regras') {
        problemas.push('nenhuma regra atingiu os pisos — as regras anteriores foram preservadas');
      }
      if (recomendacoesNaoGravadas > 0) {
        problemas.push(
          recomendacoesNaoGravadas === 1
            ? '1 recomendação NÃO foi gravada — as telas de oferta seguem com as anteriores'
            : `${recomendacoesNaoGravadas} recomendações NÃO foram gravadas — as telas de oferta seguem com as anteriores`,
        );
      }
      if (geracaoPerdida) {
        problemas.push(
          'outro recálculo deste vendedor já gravou enquanto este rodava — os bundles daqui não foram salvos, e as telas estão com o resultado mais novo',
        );
      }
      if (recalculoConcorrente) {
        problemas.push(
          'já havia um recálculo deste vendedor em andamento — os bundles daqui não foram salvos; espere ele terminar e confira',
        );
      }

      if (problemas.length > 0) {
        toast.warning(`${totalBundles} bundles gerados, mas ${problemas.join('; e ')}`);
      } else {
        toast.success(`${discoveredRules.length} regras e ${totalBundles} bundles gerados`);
      }
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
