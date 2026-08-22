import { createClient } from "npm:@supabase/supabase-js@2";
import {
  limiteCandidatos,
  projetarCandidato,
  projetarMeta,
  textoExplicacaoMargem,
} from "../_shared/recommend-projecao.ts";
// As seis leituras do motor moram em `_shared` para poderem ser EXECUTADAS num teste: esta
// edge importa `npm:@supabase/supabase-js@2` e `test:edges` roda com `--no-remote`, então
// nada afirmado aqui dentro é provável por execução. Elas paginam (o PostgREST capa em 1000
// linhas EM SILÊNCIO — o catálogo ativo tem 3.140 e a edge via 1.000) e LANÇAM na falha, em
// vez de recomendar sobre catálogo parcial. Detalhe e medições: recommend-leituras.ts.
import { carregarCluster, carregarInsumos } from "../_shared/recommend-leituras.ts";
import type { BancoPostgrest } from "../_shared/paginate.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ======== MATH HELPERS ========

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function minMaxNorm(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

// ======== COST CONTRACT (espelho VERBATIM de src/lib/custos/cost-source.ts — manter idêntico) ========
type CostRow = { cost_price: number | null; cost_final: number | null; cost_source: string | null; cost_confidence: number | null };
// CMC_MARGEM_ATIPICA = CMC real fora da banda de margem (prejuízo/baixa/alta) — REAL, propaga como custo.
const COST_SOURCES_REAIS = new Set(["PRODUCT_COST", "CMC", "CMC_MARGEM_ATIPICA"]);
// CMC_UNIDADE_SUSPEITA é descasamento de unidade (cmc por m²/m vs price noutra unidade): o cost_final é
// proxy de família, NÃO custo real — fica fora de REAIS (sem margem exibida) mas conta como PROXY p/ ranking.
const COST_SOURCES_PROXY = new Set(["FAMILY_MARGIN_PROXY", "DEFAULT_PROXY", "CMC_UNIDADE_SUSPEITA"]);
function finitePositive(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}
function normalizarSource(source: string | null | undefined): string | null {
  const s = source?.trim().toUpperCase();
  return s ? s : null;
}
function resolverCustoConfiavel(row: CostRow | null | undefined): number | null {
  const source = normalizarSource(row?.cost_source);
  if (row == null || source == null || !COST_SOURCES_REAIS.has(source)) return null;
  if (finitePositive(row.cost_final)) return row.cost_final;
  if ((source === "CMC" || source === "CMC_MARGEM_ATIPICA") && finitePositive(row.cost_price)) return row.cost_price;
  return null;
}
function estimarCustoParaRanking(row: CostRow | null | undefined, price: number): number | null {
  const real = resolverCustoConfiavel(row);
  if (real != null) return real;
  const source = normalizarSource(row?.cost_source);
  const cf = row?.cost_final ?? null;
  if (source != null && COST_SOURCES_PROXY.has(source) && finitePositive(cf) && cf < price) return cf;
  return null;
}
type MargensCandidato = { custoConfiavel: number | null; custoRanking: number | null; margemExibida: number | null; margemRanking: number | null };
function derivarMargensCandidato(row: CostRow | null | undefined, price: number): MargensCandidato {
  const custoConfiavel = resolverCustoConfiavel(row);
  const custoRanking = estimarCustoParaRanking(row, price);
  return {
    custoConfiavel,
    custoRanking,
    margemExibida: custoConfiavel != null ? price - custoConfiavel : null,
    margemRanking: custoRanking != null ? price - custoRanking : null,
  };
}
// ======== /COST CONTRACT ========

// ======== RECOMMENDATION ENGINE ========

interface Candidate {
  product_id: string;
  omie_codigo_produto: number;
  descricao: string;
  codigo: string;
  price: number;
  cost_final: number | null;
  cost_source: string;
  cost_confidence: number;
  cost_ranking: number | null;
  familia: string | null;
  estoque: number;
  margin: number | null;
  assoc_score: number;
  /** `null` = similaridade NÃO MEDIDA (disjuntor da RPC). Distinto de 0 = "medi, ninguém compra". */
  sim_score: number | null;
  ctx_score: number;
  probability: number;
  eip: number;
  eiltv: number;
  score_final: number;
  explanation_text: string;
  explanation_key: string;
  recommendation_type: string;
  penalties: number;
}

/**
 * FU4-F/3: a capability de CUSTO do usuário chamador.
 *
 * ⚠️ Recebe o client do JWT DO USUÁRIO (supabaseAuth), nunca o service_role: `public.pode_ler_custo()`
 * é sem parâmetro e resolve por `auth.uid()`. Com service_role o uid é NULL e a resposta é `false` —
 * ligar no client errado falha FECHADO (nega custo), nunca aberto.
 *
 * Fail-closed também no erro: RPC indisponível ⇒ `false`. "Não consegui verificar" não é permissão.
 */
async function podeLerCusto(dbUsuario: ReturnType<typeof createClient>): Promise<boolean> {
  const { data, error } = await dbUsuario.rpc("pode_ler_custo");
  if (error) return false;
  return data === true;
}

async function recommend(
  db: ReturnType<typeof createClient>,
  customerId: string,
  basketProductIds: string[],
  farmerId: string,
  podeCusto: boolean
) {
  // 1. Load config + customer orders + products + costs + rules + client score in PARALLEL
  // (paginado e fail-closed — ver `_shared/recommend-leituras.ts`).
  const banco = db as unknown as BancoPostgrest;
  const { configs, orderItems, products, costs, rules, clientScore } = await carregarInsumos(
    banco,
    customerId,
  );

  const cfg: Record<string, number> = {};
  for (const c of configs) cfg[c.key] = c.value;

  const wA = cfg.w_assoc ?? 0.25;
  const wP = cfg.w_eip ?? 0.35;
  const wS = cfg.w_sim ?? 0.20;
  const wC = cfg.w_ctx ?? 0.20;
  const topN = cfg.top_n_vendedor ?? 5;
  const topNAdmin = cfg.top_n_admin ?? 20;
  const epsilon = cfg.epsilon_exploration ?? 0.10;
  const mode = cfg.mode ?? 0;
  const kappa = cfg.kappa_ltv ?? 0.5;

  // Build purchased set & counts
  const purchasedProductIds = new Set<string>();
  const purchaseCounts: Record<string, number> = {};
  for (const item of orderItems) {
    if (item.product_id) {
      purchasedProductIds.add(item.product_id);
      purchaseCounts[item.product_id] = (purchaseCounts[item.product_id] || 0) + 1;
    }
  }

  // Cost map
  const costMap: Record<string, CostRow> = {};
  for (const c of costs) costMap[c.product_id] = c;

  // Association scores
  const basketSet = new Set(basketProductIds);
  const assocScores: Record<string, number> = {};
  for (const rule of rules) {
    const antecedent = rule.antecedent_product_ids || [];
    const consequent = rule.consequent_product_ids || [];
    if (!antecedent.every((id: string) => basketSet.has(id) || purchasedProductIds.has(id))) continue;
    for (const prodId of consequent) {
      const score = Math.log(Math.max(rule.lift, 1)) * rule.confidence * rule.support;
      assocScores[prodId] = Math.max(assocScores[prodId] || 0, score);
    }
  }

  // Cluster similarity - load cluster customers + their purchases in parallel
  const customerCluster = clientScore?.health_class || "misto";

  const { denominador, observados, clientesPorProduto, truncado } = await carregarCluster(
    banco,
    customerCluster,
  );

  // `sim` INDISPONÍVEL (≠ zero). O disjuntor da RPC recusou medir, então não sabemos quantos
  // clientes similares compram cada produto — e o repo proíbe transformar isso num número.
  // Antes existia um teto de 1.000 LINHAS que cortava no meio e seguia ranqueando sobre o
  // pedaço, sinalizando só por `console.warn`. Um campo que ninguém lê é o cap silencioso com
  // outro nome; aqui o sinal DESLIGA o componente.
  const simIndisponivel = truncado || clientesPorProduto === null;
  if (simIndisponivel) {
    console.warn(
      `[Recommend] similaridade INDISPONÍVEL no cluster "${customerCluster}" ` +
        `(${denominador} clientes elegíveis > teto do disjuntor) — sim_score fora do ranking, ` +
        `não zerado`,
    );
  } else {
    console.log(
      `[Recommend] similaridade sobre o cluster "${customerCluster}" INTEIRO: ` +
        `${denominador} elegíveis, ${observados} com compra no recorte, ` +
        `${Object.keys(clientesPorProduto ?? {}).length} produtos`,
    );
  }

  // DENOMINADOR = população elegível do cluster, vinda do banco. Duas correções em relação ao
  // que havia aqui: (a) não é mais `usuariosAmostrados.length` (a amostra deixou de existir), e
  // (b) o numerador não vem mais de uma leitura capada em 1.000 linhas que zerava clientes
  // reais — 5 em `atencao` e 2 em `estavel`, medido. O `Math.max(…, 1)` continua sendo só
  // guarda de divisão por zero: com denominador 0 não há produto no agregado, então nenhum
  // `sim` chega a ser calculado.
  const clusterSize = Math.max(denominador, 1);

  // O que a correção move, e o que NÃO move (medido em prod, psql-ro):
  //   · NÃO move o componente `score_sim` do score ponderado: `minMaxNorm` é `(v-min)/(max-min)`,
  //     afim-invariante, e um fator uniforme cancela;
  //   · MOVE os três cortes em `sim` CRU (0,10 do ctx, 0,15 do recType, 0,20 da explicação) —
  //     são comparações contra constante, onde fator uniforme não cancela;
  //   · MOVE o caminho `simNorm → sigmoid → probability → eip`, de peso 0,35 (o MAIOR): o
  //     sigmoide não é linear, então a normalização a jusante não desfaz a mudança;
  //   · MOVE `probability`, que o vendedor VÊ como "Prob. conversão" em `RecommendationCard`.
  const clusterProductCounts: Record<string, number> = clientesPorProduto ?? {};

  // Build candidates
  const candidates: Candidate[] = [];
  const basketFamilies: Record<string, number> = {};

  for (const p of products) {
    if (basketSet.has(p.id)) continue;
    if ((p.estoque || 0) <= 0) continue;

    const cost = costMap[p.id];
    const price = p.valor_unitario || 0;
    if (price <= 0) continue;

    const { custoConfiavel, custoRanking, margemExibida, margemRanking } = derivarMargensCandidato(cost ?? null, price);
    const margemRank = margemRanking ?? 0; // EIP neutro (0, não máximo) quando custo de ranking ausente
    const assoc = assocScores[p.id] || 0;
    // `null` = não medido (disjuntor). NUNCA 0 — este é exatamente o `Number(null) === 0` que
    // fabricaria "nenhum cliente similar compra isto" a partir de "não perguntei".
    const sim: number | null = simIndisponivel ? null : (clusterProductCounts[p.id] ?? 0) / clusterSize;

    const hasPurchased = purchasedProductIds.has(p.id);
    const purchaseCount = purchaseCounts[p.id] || 0;
    let ctx = 0;
    // `sim !== null &&` explícito: `null > 0.1` já é `false` em JS, mas quem lê a linha
    // não deve ter que confiar em coerção para saber que ausência não vira gatilho.
    if (!hasPurchased && sim !== null && sim > 0.1) ctx += 0.3;
    if (purchaseCount >= 2) ctx += 0.2;

    const assocNorm = assoc > 0 ? Math.min(assoc / 2, 1) : 0;
    const simNorm = sim === null ? 0 : Math.min(sim, 1);
    const ctxNorm = Math.min(ctx, 1);

    // Sem sinal de cluster o termo de `sim` SAI do modelo — não entra como 0 "medido". O efeito
    // é subestimar a conversão, que é a direção conservadora (precisão > recall): melhor mostrar
    // uma probabilidade baixa demais do que afirmar uma que não medimos. O vendedor lê este
    // número como "Prob. conversão" em `RecommendationCard`.
    const probability = simIndisponivel
      ? sigmoid(-1.5 + 2.0 * assocNorm + 1.0 * ctxNorm)
      : sigmoid(-1.5 + 2.0 * assocNorm + 1.5 * simNorm + 1.0 * ctxNorm);
    const eip = probability * margemRank;
    const recurrenceScore = Math.min(purchaseCount / 5, 1);
    const eiltv = probability * (margemRank + kappa * recurrenceScore * margemRank);

    let penalties = 0;
    const familia = p.familia || "other";
    if (basketFamilies[familia]) penalties += 0.1 * basketFamilies[familia];

    let recType = "cross_sell";
    if (hasPurchased) recType = "repurchase";
    else if (assoc > 0) recType = "cross_sell";
    else if (sim !== null && sim > 0.15) recType = "cluster_based";

    let explanationKey = "margin";
    let explanationText = "";
    if (assoc > 0.5) {
      explanationKey = "association";
      explanationText = `Clientes que compraram itens do seu carrinho frequentemente também compraram ${p.descricao}`;
    } else if (sim !== null && sim > 0.2) {
      explanationKey = "cluster";
      explanationText = `${Math.round(sim * 100)}% dos clientes similares compram ${p.descricao}`;
    } else if (margemExibida != null && margemExibida > 50) {
      explanationKey = "margin";
      // O R$ ia EMBUTIDO NA PROSA — nenhum gate de campo pegaria isto. O sinal fica, o número sai.
      explanationText = textoExplicacaoMargem(p.descricao, margemExibida, podeCusto);
    } else if (ctx > 0.2) {
      explanationKey = "context";
      explanationText = `Baseado no histórico de compras, ${p.descricao} complementa bem o mix`;
    } else {
      explanationText = `${p.descricao} é uma boa adição ao mix de compras`;
    }

    candidates.push({
      product_id: p.id, omie_codigo_produto: p.omie_codigo_produto,
      descricao: p.descricao, codigo: p.codigo, price,
      cost_final: custoConfiavel, cost_source: cost?.cost_source || "UNKNOWN",
      cost_confidence: cost?.cost_confidence || 0, cost_ranking: custoRanking, familia: p.familia,
      estoque: p.estoque || 0, margin: margemExibida, assoc_score: assoc, sim_score: sim,
      ctx_score: ctx, probability, eip, eiltv, score_final: 0,
      explanation_text: explanationText, explanation_key: explanationKey,
      recommendation_type: recType, penalties,
    });

    basketFamilies[familia] = (basketFamilies[familia] || 0) + 1;
  }

  // ⚠️ o retorno vazio TAMBÉM passa pela projeção: `weights` é insumo da inversão de score_final e
  // vazava por aqui. (O `mode` fixo em "profit" desta linha é inconsistência PRÉ-EXISTENTE com o
  // retorno principal — preservada verbatim para manter o diff restrito a autorização.)
  if (candidates.length === 0) {
    return { recommendations: [], meta: projetarMeta(0, "profit", { wA, wP, wS, wC }, topN, podeCusto) };
  }

  // Normalize and score
  const assocNormed = minMaxNorm(candidates.map((c) => c.assoc_score));
  const eipNormed = minMaxNorm(candidates.map((c) => mode === 0 ? c.eip : c.eiltv));
  // `?? 0` é seguro AQUI e só aqui: quando `sim` é null ele é null para TODOS os candidatos
  // (o disjuntor é do cluster, não do produto), e o bloco abaixo tira o componente do score
  // inteiro. Sem essa renormalização o `?? 0` seria o zero fabricado de sempre.
  const simNormed = minMaxNorm(candidates.map((c) => c.sim_score ?? 0));
  const ctxNormed = minMaxNorm(candidates.map((c) => c.ctx_score));

  // Similaridade indisponível ⇒ o componente SAI e os outros três dividem o peso dele.
  //
  // Por que renormalizar em vez de deixar `sim = 0` entrar: `minMaxNorm` de todos-zeros devolve
  // 0,5 uniforme, então `wS` viraria uma constante somada a todo candidato — inofensiva no
  // ranking, mas o `score_final` sairia numa escala DIFERENTE da dos clusters medidos, e ele é
  // gravado em `recommendation_log` e comparado entre execuções. Redistribuir mantém o score
  // somando os mesmos pesos e diz a verdade: decidimos com três sinais, não quatro.
  const somaPesos = wA + wP + wS + wC;
  const semSim = wA + wP + wC;
  // `semSim > 0` guarda a config degenerada (todo peso em `w_sim`): aí não há para onde
  // redistribuir e o fator cairia em divisão por zero.
  const fator = simIndisponivel && semSim > 0 ? somaPesos / semSim : 1;
  const pA = simIndisponivel ? wA * fator : wA;
  const pP = simIndisponivel ? wP * fator : wP;
  const pC = simIndisponivel ? wC * fator : wC;
  const pS = simIndisponivel ? 0 : wS;

  for (let i = 0; i < candidates.length; i++) {
    candidates[i].score_final = pA * assocNormed[i] + pP * eipNormed[i] + pS * simNormed[i] + pC * ctxNormed[i] - candidates[i].penalties;
  }

  // Epsilon-greedy
  for (const c of candidates) {
    if (Math.random() < epsilon) c.score_final += Math.random() * 0.3;
  }

  candidates.sort((a, b) => b.score_final - a.score_final);
  // Sem a capability, `top_n_vendedor` (5) em vez de `top_n_admin` (20): a config já distinguia os
  // dois e o código devolvia 20 para todos. Menos itens = menos superfície do canal de ordenação.
  const topCandidates = candidates.slice(0, limiteCandidatos(topN, topNAdmin, podeCusto));

  // BATCH log impressions (single insert instead of N inserts)
  const logRows = topCandidates.slice(0, topN).map((c) => ({
    farmer_id: farmerId,
    customer_user_id: customerId,
    product_id: c.product_id,
    recommendation_type: c.recommendation_type,
    score_final: c.score_final,
    score_assoc: c.assoc_score,
    score_eip: c.eip,
    score_sim: c.sim_score,
    score_ctx: c.ctx_score,
    explanation_text: c.explanation_text,
    explanation_key: c.explanation_key,
    unit_cost: c.cost_final,
    cost_source: c.cost_source,
    margin: c.margin,
    probability: c.probability,
    // EIP é money (R$ lucro esperado): null quando o custo não é confiável (margin null) — só
    // score_eip (acima) segue numérico, é o SCORE de ranking, não uma afirmação de lucro firme.
    eip: c.margin != null ? c.eip : null,
    event_type: "impression",
    mode: mode === 0 ? "profit" : "ltv",
    // Os pesos EFETIVAMENTE aplicados, não os de config: com similaridade indisponível o
    // componente saiu e os outros três absorveram o peso dele. Gravar a config aqui faria o
    // `recommendation_log` afirmar uma decomposição que não produziu este `score_final` — e é
    // por este log que se audita ranking depois.
    weights: { wA: pA, wP: pP, wS: pS, wC: pC },
  }));

  if (logRows.length > 0) {
    await db.from("recommendation_log").insert(logRows);
  }

  // FU4-F/3: a decisão de quem vê número acontece AQUI, no servidor. Antes, `_admin.cost_final` ia
  // para todo staff e o browser apagava depois de receber (useRecommendationEngine.ts) — a resposta
  // de rede já tinha entregue o custo.
  return {
    recommendations: topCandidates.map((c) => projetarCandidato(c, podeCusto)),
    meta: projetarMeta(
      candidates.length,
      mode === 0 ? "profit" : "ltv",
      { wA: pA, wP: pP, wS: pS, wC: pC },
      topN,
      podeCusto,
    ),
  };
}

// ======== LOG EVENT ========

async function logEvent(
  db: ReturnType<typeof createClient>,
  farmerId: string,
  customerId: string,
  productId: string,
  eventType: string,
  extras: Record<string, unknown> = {}
) {
  await db.from("recommendation_log").insert({
    farmer_id: farmerId,
    customer_user_id: customerId,
    product_id: productId,
    event_type: eventType,
    ...extras,
    // Evento (accept/reject) não carrega custo/margem (a impressão carregou) → null EXPLÍCITO e
    // DEPOIS de ...extras (autoritativo, não clobberável), senão o DEFAULT 0 do schema fabrica R$0
    // (Codex #4 fabricação + #6 ordem do spread).
    unit_cost: null,
    margin: null,
  });
  return { logged: true };
}

// ======== MAIN HANDLER ========

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Sonda de versão ────────────────────────────────────────────────────────────────
    // Responde ANTES do `createClient` e de qualquer leitura/escrita: o ponto da canária é
    // dizer QUAL bundle está no ar sem pagar o efeito da edge. Aqui o efeito é gravar
    // `recommendation_log` — o sensor de desfecho do motor (#1851) —, e uma linha inventada
    // por sondagem entraria no denominador de "a recomendação virou venda".
    //
    // ANTES do gate de `Bearer ` do handler, e isto é o ponto (corrige o #1877): aquele gate
    // exige `Authorization: Bearer …`, então um request com `x-cron-secret` e sem Authorization
    // morria nele e NUNCA alcançava `authorizeCronOrStaff` — justamente quem sabe validar o
    // cron secret. Medido em prod: `net.http_post` do SQL Editor com o secret devolveu 401
    // {"error":"Não autorizado"} (mensagem do HANDLER). Das três credenciais que o helper
    // aceita, só as que por acaso vinham em `Bearer` chegavam até ele — e o caminho
    // DOCUMENTADO para sondar era exatamente o que não passava.
    //
    // A sonda não fica desprotegida: quem a gateia é o `authorizeCronOrStaff` logo abaixo, que
    // é mais estrito que o `startsWith("Bearer ")` daqui (este aceita qualquer string).
    //
    // O corpo é lido AQUI (antes era só na linha do `switch`) porque a decisão depende dele.
    // JSON malformado passa a devolver 400 explícito em vez de cair no catch genérico — o
    // status muda de 500 para 400, que é a classificação correta de corpo inválido.
    let corpoBruto: unknown;
    try {
      corpoBruto = await req.json();
    } catch {
      return jsonRes({ error: "invalid JSON" }, 400);
    }
    // Gate PRÓPRIO da sonda (padrão de `omie-cliente`), e não o `Bearer ` do handler.
    //
    // O gate normal desta edge é JWT, e `supabaseAuth.auth.getUser()` PRECISA do client — que
    // ainda não existe aqui, porque a sonda tem de responder antes dele. Sobrava então só o
    // `startsWith("Bearer ")` lá em cima, que qualquer string satisfaz: medido em PROD,
    // `Authorization: Bearer x` devolvia `{"versao":"v1.2-cluster-rpc"}`. A versão do bundle
    // virava pública para quem tivesse a URL — semi-público por ACIDENTE, que é diferente de
    // público por decisão.
    //
    // `authorizeCronOrStaff` resolve os dois lados: valida `x-cron-secret`, service role ou o
    // JWT de verdade (via `fetch` em /auth/v1/user), sem `createClient` — então autentica sem
    // violar a ordem que o gate de CI exige.
    //
    // Só roda quando `probe` VEM no corpo (`tipo !== "disparo"`): o caminho normal da edge não
    // paga nada por esta checagem.
    const decisaoSonda = classificarSonda(corpoBruto);
    if (decisaoSonda.tipo !== "disparo") {
      const authSonda = await authorizeCronOrStaff(req);
      if (!authSonda.ok) return authSonda.response;
      if (decisaoSonda.tipo === "sonda") return jsonRes(respostaSonda(VERSAO), 200);
      return jsonRes({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonRes({ error: "Não autorizado" }, 401);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userError || !user) {
      return jsonRes({ error: "Token inválido" }, 401);
    }

    // Staff-only: this function exposes internal cost/margin/EIP data and
    // cross-customer purchase aggregates. Restrict to staff roles.
    const { data: roleRows, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    if (roleErr) {
      return jsonRes({ error: "Falha ao validar permissão" }, 500);
    }
    const STAFF_ROLES = new Set(["employee", "master"]);
    const isStaff = (roleRows ?? []).some((r: { role: string }) => STAFF_ROLES.has(r.role));
    if (!isStaff) {
      return jsonRes({ error: "Forbidden" }, 403);
    }

    // Corpo já consumido pela sonda acima — `req.json()` só pode ser lido UMA vez; chamar de
    // novo devolveria erro de stream já travado.
    const { action, ...params } = (corpoBruto ?? {}) as { action?: string; [k: string]: unknown };
    let result: unknown;

    switch (action) {
      case "recommend": {
        const { customer_id, basket_product_ids = [] } = params;
        if (!customer_id) throw new Error("customer_id obrigatório");
        // ⚠️ supabaseAuth (JWT do usuário), NÃO supabaseAdmin: pode_ler_custo() resolve por
        // auth.uid(). Com service_role o uid é NULL e a resposta seria `false` — fail-closed.
        const podeCusto = await podeLerCusto(supabaseAuth);
        result = await recommend(supabaseAdmin, customer_id, basket_product_ids, user.id, podeCusto);
        break;
      }
      case "log_accept": {
        const { customer_id, product_id, quantity_accepted, sales_order_id } = params;
        result = await logEvent(supabaseAdmin, user.id, customer_id, product_id, "accept", {
          quantity_accepted, sales_order_id,
        });
        break;
      }
      case "log_reject": {
        const { customer_id, product_id } = params;
        result = await logEvent(supabaseAdmin, user.id, customer_id, product_id, "reject");
        break;
      }
      default:
        return jsonRes({ error: "Ação desconhecida" }, 400);
    }

    return jsonRes({ success: true, data: result });
  } catch (error) {
    console.error("[Recommend] Erro:", error);
    return jsonRes(
      { success: false, error: error instanceof Error ? error.message : "Erro interno" },
      500
    );
  }
});
