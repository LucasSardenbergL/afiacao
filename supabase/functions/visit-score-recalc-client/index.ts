// supabase/functions/visit-score-recalc-client/index.ts
//
// PR-VISIT-INTELLIGENCE Sub-PR A — edge function que computa visit_score.
//
// NOTA: lógica de scoring duplicada inline (Deno não importa de src/).
// TODO Sub-PR debt: extrair pra supabase/functions/_shared/visit-scoring/
// (junto com extração do PR-SCORING-V2 V2.1 — mesmo problema).
//
// Auth: authorizeCronOrStaff (cron via x-cron-secret OU staff JWT).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';
import { exigirLeitura, FalhaLeituraCritica } from '../_shared/leitura-critica.ts';
import { STATUS_NAO_VENDA_POSTGREST } from '../_shared/universo-pedidos.ts';
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

// =====================================================
// --- Inline helpers ---
// =====================================================
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
function normalizeRevenue(value: number): number {
  if (value <= 0) return 0;
  return Math.min(1, value / 10000);
}
function computeDays(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  return Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / MS_PER_DAY));
}

// MIRROR-START valor-medido — espelhado verbatim de src/lib/scoring/margin.ts
function valorMedido(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
// MIRROR-END

// MIRROR-START carteira-sem-pedido — espelhado verbatim de src/lib/visit-scoring/missions.ts
// Plano v8, D13 — decisão do founder em 2026-11-11: o cliente da carteira que nunca comprou fica
// ABAIXO de quem compra nas sugestões de visita. Antes ele ganhava 90 (prospecção 70 + 20 de
// "cadastro novo" fabricado pela data do import do Omie) e ocupava o top 30 inteiro da cidade.
//
// Por que 10 (psql-ro, 2026-11-11): o menor visit_score de quem compra é 19,97 (p5 25,1; 1.237
// compradores com linha), e 42% dos ativos ficam em 30 ou menos. Qualquer piso que deixe o nunca
// comprou acima do corte `> 30` do card passaria na frente desses ativos. Com churn = 100 - health
// (0 divergências em 17.002 linhas de farmer_client_scores), o piso teórico de quem compra é
// ~13 (recuperação e relacionamento se cruzam em health ~54 com penalidade de recência máxima e
// visita no dia). 10 fica abaixo dos dois e acima de 0, o "não candidato", para ainda preencher
// as vagas que sobram depois dos compradores.
const SCORE_CARTEIRA_SEM_PEDIDO = 10;

// Nunca comprou = nenhum pedido de venda E o histórico canônico não diz ativo/stale. `null` no
// status (ainda não computado) não prova compra, então vale só o pedido.
function nuncaComprou(c: { sales_orders_count: number; sales_history_status: string | null }): boolean {
  if (c.sales_orders_count > 0) return false;
  return c.sales_history_status !== 'ativo' && c.sales_history_status !== 'stale';
}

// O +20 de "novo" é para cadastro de verdade: no perfil do import, o created_at é a data do import.
function cadastroRecente(c: { days_since_signup: number; prospect_source: string | null }): boolean {
  return c.days_since_signup < 30 && c.prospect_source !== 'omie_import';
}
// MIRROR-END

// =====================================================
// --- Inline types ---
// =====================================================
type MissionType = 'recuperacao' | 'expansao' | 'relacionamento' | 'prospeccao';

interface SignalModifier {
  dimension: string;
  delta: number;
  decayedWeight: number;
  // FA4 (shadow-mode): a Task 4 carimba a classe de sinal em TODA modifier
  // ('preco'|'marca'|'demanda'). O visit-score só aplica modifiers de classe ATIVADA
  // (sinal_classe_config.ativado=true). Modifier sem class ou de classe off → excluído.
  class?: 'preco' | 'marca' | 'demanda';
}

interface ScoreAdjustment {
  breakdown: {
    churn: SignalModifier[];
    expansion: SignalModifier[];
    health: SignalModifier[];
    eff: SignalModifier[];
  };
  source_call_count: number;
}

interface CustomerScoreInputs {
  customer_user_id: string;
  farmer_id: string;
  churn_risk: number;
  // ⚠️ `number | null`: estas três colunas NUNCA tiveram produtor — NULL em 6.633/6.633 linhas
  // (medido 2026-07-27). Espelha CustomerScoreInputs de src/lib/visit-scoring/types.ts.
  expansion_score: number | null;
  health_score: number;
  recover_score: number | null;
  revenue_potential: number | null;
  avg_monthly_spend_180d: number;
  days_since_last_purchase: number;
  // Classificação canônica do histórico de compra; null = ainda não computado.
  sales_history_status: 'ativo' | 'stale' | 'sem_historico' | null;
  signal_modifiers: ScoreAdjustment | null;
  days_since_last_visit: number | null;
  last_visit_at: string | null;
  sales_orders_count: number;
  is_prospect: boolean;
  days_since_signup: number;
  // 'omie_import' = perfil do import da carteira: created_at é a data do import (D13).
  prospect_source: string | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
}

/**
 * Resultado de UMA missão. Espelha MissionResult de src/lib/visit-scoring/types.ts.
 *
 * REGRA ÚNICA (vale para as 4 missões): `score` é `null` somente quando NENHUM insumo da missão
 * foi medido — "não avaliada". Se ao menos um insumo existe, o score é um número e
 * `insumosAusentes` nomeia os que faltaram ("parcial").
 */
interface MissionResult {
  score: number | null;
  insumosAusentes: string[];
}

// =====================================================
// --- Inline missions ---
// =====================================================

// FA4 (shadow-mode — salvaguarda money-path): filtra os modifiers de um breakdown[dim]
// mantendo SÓ os de classe ATIVADA (sinal_classe_config.ativado=true). Modifier sem class
// (legado não-carimbado) OU de classe desligada → excluído.
// INVARIANTE: com a config tudo OFF (estado inicial), `classesAtivas` é vazio → `aplicaveis`
// retorna sempre [] → todo signalsBoost vira 0 → o visit_score fica IDÊNTICO ao de hoje.
// É isso que torna o deploy da Fatia 2 seguro (nada muda na oferta até a Fase C ligar uma classe).
function aplicaveis(
  mods: SignalModifier[] | undefined,
  classesAtivas: Set<string>,
): SignalModifier[] {
  return (mods ?? []).filter((m) => m.class != null && classesAtivas.has(m.class));
}

/**
 * RECUPERAÇÃO — cliente que comprava bem e parou. Espelha scoreRecuperacao de
 * src/lib/visit-scoring/missions.ts.
 *
 * `recover_score` é `null` em 100% da base (sem produtor). Pela REGRA ÚNICA ela NÃO vira null:
 * `churn_risk` está medido em 6.633/6.633 linhas e sustenta a missão sozinho. O ausente é
 * NOMEADO, não fabricado como 0.
 */
function scoreRecuperacao(c: CustomerScoreInputs, classesAtivas: Set<string>): MissionResult {
  // Quem nunca comprou não tem o que recuperar: medido, vale 0 (D13; espelha src/).
  if (nuncaComprou(c)) return { score: 0, insumosAusentes: [] };
  const insumosAusentes: string[] = [];
  let insumosMedidos = 0;

  const churnBoost = c.churn_risk * 0.5;
  insumosMedidos++; // churn_risk sempre tem produtor (nunca null no tipo) — sustenta a missão sozinho

  // Guard explícito ANTES do uso: `null * 0.3` é 0 em JS, que afirmaria "medi e não há o que
  // recuperar". Sem produtor, o componente simplesmente não entra na soma.
  let recoverBoost = 0;
  if (c.recover_score == null) insumosAusentes.push('recover_score');
  else {
    recoverBoost = c.recover_score * 0.3;
    insumosMedidos++;
  }

  const recencyPenalty = Math.max(0, 100 - c.days_since_last_purchase) * -0.1;
  // aplicaveis(...).reduce(...) é o somaModifiers do src/ + o filtro FA4 (shadow-mode) que só
  // existe no edge: mantém SÓ modifiers de classe ATIVADA.
  const signalsBoost = aplicaveis(c.signal_modifiers?.breakdown?.churn, classesAtivas)
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.1;

  // REGRA ÚNICA (mesmo padrão de scoreExpansao): nenhum insumo medido → não avaliada. Hoje é
  // inatingível aqui — churn_risk sempre tem produtor — mas a regra existe uma vez só.
  if (insumosMedidos === 0) return { score: null, insumosAusentes };

  const score = clamp(churnBoost + recoverBoost + recencyPenalty + signalsBoost, 0, 100);
  return { score, insumosAusentes };
}

/**
 * EXPANSÃO — cliente saudável com upsell quente. Espelha scoreExpansao de
 * src/lib/visit-scoring/missions.ts.
 *
 * Os DOIS insumos (`expansion_score`, `revenue_potential`) são `null` em 100% da base e nunca
 * tiveram produtor. Pela REGRA ÚNICA, nenhum insumo medido → `score: null` = "não avaliada".
 */
function scoreExpansao(c: CustomerScoreInputs, classesAtivas: Set<string>): MissionResult {
  const insumosAusentes: string[] = [];
  let insumosMedidos = 0;

  let expansionBase = 0;
  if (c.expansion_score == null) insumosAusentes.push('expansion_score');
  else {
    expansionBase = c.expansion_score * 0.6;
    insumosMedidos++;
  }

  // ⚠️ Guard ANTES de normalizeRevenue: ele faz `if (value <= 0) return 0`, e `null <= 0` é
  // `true` em JS — o null entraria e sairia como 0 medido, em silêncio.
  let revenueBoost = 0;
  if (c.revenue_potential == null) insumosAusentes.push('revenue_potential');
  else {
    revenueBoost = normalizeRevenue(c.revenue_potential) * 20;
    insumosMedidos++;
  }

  const signalsBoost = aplicaveis(c.signal_modifiers?.breakdown?.expansion, classesAtivas)
    .reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.2;

  // REGRA ÚNICA (mesmo padrão de scoreRecuperacao): nenhum insumo medido → não avaliada.
  if (insumosMedidos === 0) return { score: null, insumosAusentes };

  return { score: clamp(expansionBase + revenueBoost + signalsBoost, 0, 100), insumosAusentes };
}

/**
 * RELACIONAMENTO — cliente VIP saudável precisando manutenção. Espelha scoreRelacionamento de
 * src/lib/visit-scoring/missions.ts. Todos os insumos têm produtor → nunca fica null.
 */
function scoreRelacionamento(c: CustomerScoreInputs): MissionResult {
  // Sem compra não há relacionamento a manter (D13; espelha src/).
  if (nuncaComprou(c)) return { score: 0, insumosAusentes: [] };
  // health_score é 0..100 (calculate-scores). * 0.5 → contribuição 0..50.
  const healthBoost = c.health_score * 0.5;
  const revenueBoost = normalizeRevenue(c.avg_monthly_spend_180d) * 30;
  // ?? 30 (não 365) — null = sem histórico de visita = sem relacionamento estabelecido.
  // Mesma decisão de src/lib/visit-scoring/missions.ts.
  const daysSinceVisitBoost = Math.min(40, (c.days_since_last_visit ?? 30) * 0.3);
  const riskPenalty = c.churn_risk * 0.3;
  const score = clamp(healthBoost + revenueBoost + daysSinceVisitBoost - riskPenalty, 0, 100);
  return { score, insumosAusentes: [] };
}

/**
 * PROSPECÇÃO — dois públicos (plano v8, D13; espelha scoreProspeccao de src/):
 * - lead declarado (`is_prospect`): base 70, +20 se o cadastro é recente DE VERDADE, +10 com sinal;
 * - cliente da carteira que nunca comprou: SCORE_CARTEIRA_SEM_PEDIDO, abaixo de quem compra.
 * Quem já comprou e não é lead não é candidato (0). A qualidade de sinal usa `aplicaveis(...)`
 * (FA4 shadow-mode), que só existe no edge: com a config tudo OFF, o boost fica 0.
 */
function scoreProspeccao(c: CustomerScoreInputs, classesAtivas: Set<string>): MissionResult {
  if (c.is_prospect === true) {
    const baseProspect = 70;
    const recencyOfSignup = cadastroRecente(c) ? 20 : 0;
    const bd = c.signal_modifiers?.breakdown;
    const temSinalAplicavel =
      aplicaveis(bd?.churn, classesAtivas).length > 0 ||
      aplicaveis(bd?.expansion, classesAtivas).length > 0 ||
      aplicaveis(bd?.health, classesAtivas).length > 0 ||
      aplicaveis(bd?.eff, classesAtivas).length > 0;
    const signalsQuality = temSinalAplicavel ? 10 : 0;
    return { score: clamp(baseProspect + recencyOfSignup + signalsQuality, 0, 100), insumosAusentes: [] };
  }
  if (nuncaComprou(c)) return { score: SCORE_CARTEIRA_SEM_PEDIDO, insumosAusentes: [] };
  return { score: 0, insumosAusentes: [] };
}

/**
 * Computa o visit_score final + primary_mission. Espelha computeVisitScore de
 * src/lib/visit-scoring/missions.ts, com `classesAtivas` (FA4 shadow-mode) plugado nas 3
 * missões que usam `aplicaveis(...)`.
 *
 * ⚠️ Missão com `score: null` ("não avaliada") é IGNORADA no argmax — não tratada como 0.
 */
function computeVisitScore(c: CustomerScoreInputs, classesAtivas: Set<string>): {
  scores: Record<MissionType, MissionResult>;
  visit_score: number;
  primary_mission: MissionType;
  insumos_ausentes: string[];
} {
  const scores: Record<MissionType, MissionResult> = {
    recuperacao: scoreRecuperacao(c, classesAtivas),
    expansao: scoreExpansao(c, classesAtivas),
    relacionamento: scoreRelacionamento(c),
    prospeccao: scoreProspeccao(c, classesAtivas),
  };
  const ORDER: MissionType[] = ['expansao', 'recuperacao', 'relacionamento', 'prospeccao'];

  // Semente na prospecção, que nunca é null (insumos sempre presentes).
  let primary_mission: MissionType = 'prospeccao';
  let visit_score = scores.prospeccao.score ?? 0;

  for (const m of ORDER) {
    const s = scores[m].score;
    if (s == null) continue; // não avaliada: fora da disputa, jamais como 0
    if (s > visit_score) {
      visit_score = s;
      primary_mission = m;
    }
  }

  return {
    scores,
    visit_score,
    primary_mission,
    // Cópia — não vaza a referência mutável do array interno de MissionResult (mesma razão de
    // src/lib/visit-scoring/missions.ts).
    insumos_ausentes: [...scores[primary_mission].insumosAusentes],
  };
}

// =====================================================
// --- IO helpers ---
// =====================================================
// Valor fora do domínio (ou ausente) vira null = "não computado": não prova compra nem a nega.
function statusHistorico(raw: unknown): 'ativo' | 'stale' | 'sem_historico' | null {
  return raw === 'ativo' || raw === 'stale' || raw === 'sem_historico' ? raw : null;
}

function jsonError(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface RecalcRequest {
  customer_user_id?: string;
  farmer_id?: string;
  drain_queue?: boolean;
  max_drain?: number;
}

// =====================================================
// --- Recalc core ---
// =====================================================
async function recalcOne(
  supabase: ReturnType<typeof createClient>,
  customer_user_id: string,
  farmer_id: string,
): Promise<{ ok: boolean; error?: string; visit_score?: number; primary_mission?: MissionType }> {
  const [flagRes, scoresRes, visitsRes, ordersRes, addressRes, profileRes, classCfgRes] = await Promise.all([
    // Anti-ressurreição (fornecedores fora da carteira): cliente marcado p/ exclusão não recebe
    // visit score. Checagem na mesma rodada paralela → zero latência extra. Ausência = segue.
    supabase.from('cliente_classificacao').select('user_id').eq('user_id', customer_user_id).eq('excluir_da_carteira', true).maybeSingle(),
    // Opção A (carteira-Omie): 1 linha de score por cliente → lê por customer_user_id só.
    supabase.from('farmer_client_scores').select('churn_risk, expansion_score, health_score, recover_score, revenue_potential, avg_monthly_spend_180d, days_since_last_purchase, sales_history_status, signal_modifiers').eq('customer_user_id', customer_user_id).maybeSingle(),
    supabase.from('route_visits').select('check_in_at').eq('customer_user_id', customer_user_id).order('check_in_at', { ascending: false }).limit(1),
    // Prospect = quem NUNCA COMPROU: conta só pedido de venda (o universo canônico). Orçamento,
    // rascunho e cancelado não tiram ninguém de prospect (0 clientes afetados em 2026-10-01).
    supabase.from('sales_orders').select('id').eq('customer_user_id', customer_user_id)
      .not('status', 'in', STATUS_NAO_VENDA_POSTGREST).is('deleted_at', null),
    supabase.from('addresses').select('city, neighborhood, state').eq('user_id', customer_user_id).eq('is_default', true).maybeSingle(),
    supabase.from('profiles').select('created_at, is_prospect, prospect_source').eq('user_id', customer_user_id).maybeSingle(),
    // FA4 (shadow-mode): classes de sinal ATIVADAS. Leitura na mesma rodada paralela (1 query,
    // não N+1 — a tabela tem só 3 linhas; ler por cliente é trivial e mantém recalcOne autossuficiente).
    // Estado inicial: tudo ativado=false → nenhuma linha aqui → classesAtivas vazio (invariante = boost 0).
    supabase.from('sinal_classe_config').select('classe').eq('ativado', true),
  ]);

  // FAIL-CLOSED (Codex P1): erro ao ler a flag → NÃO recalcula (não recria score de fornecedor
  // por erro transitório). Re-enfileirado no próximo batch.
  if (flagRes.error) return { ok: false, error: `cliente_classificacao: ${flagRes.error.message}` };
  if (flagRes.data) return { ok: true };
  if (scoresRes.error) return { ok: false, error: `farmer_client_scores: ${scoresRes.error.message}` };

  // FA4 (shadow-mode): classes ATIVADAS. Fail-SAFE no sentido do shadow — erro na leitura da config
  // degrada para conjunto VAZIO (jamais sobre-aplica sinal: o pior caso vira "idêntico a hoje").
  // Com tudo ativado=false (estado inicial) classesAtivas já é vazio por construção.
  const classesAtivas = new Set<string>(
    classCfgRes.error
      ? []
      : ((classCfgRes.data ?? []) as Array<{ classe: string }>).map((r) => r.classe),
  );

  const scores = (scoresRes.data ?? {}) as Record<string, unknown>;

  // FAIL-CLOSED (mesma regra do flagRes acima) nas 4 leituras que alimentam o SCORE, que
  // até aqui descartavam `error`. O `?? []`/`?? {}` cru colapsava "a leitura FALHOU" em
  // "o cliente não teve atividade", e o estrago não é um score ausente e visível — é um
  // score BAIXO e plausível: sem route_visits o cliente vira "nunca visitado", sem
  // sales_orders vira "não compra", e o profile perdido zera `is_prospect`, o que TROCA a
  // missão primária. Um timeout de transporte rebaixava o cliente na agenda do vendedor,
  // com 200 na resposta e o resultado PERSISTIDO no upsert lá embaixo. Melhor não
  // recalcular do que recalcular errado em silêncio (docs/agent/money-path.md §2/§6/§7):
  // o score anterior fica de pé, o motivo é gravado na fila (o drain marca `processed_at`
  // mesmo em erro, anti poison-pill) e o cliente é re-enfileirado no próximo batch — o
  // mesmo desfecho que o flagRes acima já dá.
  // `exigirLeitura` lança só no `error`: `data` null/[] sem erro segue sendo ausência
  // LEGÍTIMA, e o fallback abaixo continua valendo. A mensagem vai em domínio fechado
  // (fonte + código), sem o `error.message` cru do Postgres que o retorno devolve ao
  // cliente — o mesmo cuidado de PII que o helper documenta.
  let visitas: Array<{ check_in_at?: string | null }>;
  let pedidos: unknown[];
  let address: Record<string, unknown>;
  let profile: Record<string, unknown>;
  try {
    visitas = (exigirLeitura(visitsRes, 'route_visits') ?? []) as Array<{ check_in_at?: string | null }>;
    pedidos = (exigirLeitura(ordersRes, 'sales_orders') ?? []) as unknown[];
    address = (exigirLeitura(addressRes, 'addresses') ?? {}) as Record<string, unknown>;
    profile = (exigirLeitura(profileRes, 'profiles') ?? {}) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof FalhaLeituraCritica) return { ok: false, error: e.message };
    throw e;
  }

  const lastVisitAt = visitas[0]?.check_in_at ?? null;
  const salesOrdersCount = pedidos.length;

  const inputs: CustomerScoreInputs = {
    customer_user_id,
    farmer_id,
    churn_risk: Number(scores.churn_risk ?? 0),
    // ausente ≠ zero: as 3 colunas abaixo nunca tiveram writer (NULL em 6.633/6.633 linhas).
    // valorMedido degrada para null em vez de fabricar 0 — as missões tratam a ausência.
    expansion_score: valorMedido(scores.expansion_score),
    health_score: Number(scores.health_score ?? 0),
    recover_score: valorMedido(scores.recover_score),
    revenue_potential: valorMedido(scores.revenue_potential),
    avg_monthly_spend_180d: Number(scores.avg_monthly_spend_180d ?? 0),
    days_since_last_purchase: Number(scores.days_since_last_purchase ?? 999),
    sales_history_status: statusHistorico(scores.sales_history_status),
    signal_modifiers: (scores.signal_modifiers ?? null) as ScoreAdjustment | null,
    days_since_last_visit: computeDays(lastVisitAt),
    last_visit_at: lastVisitAt,
    sales_orders_count: salesOrdersCount,
    is_prospect: Boolean(profile.is_prospect ?? false),
    days_since_signup: computeDays(profile.created_at as string) ?? 999,
    prospect_source: typeof profile.prospect_source === 'string' ? profile.prospect_source : null,
    city: (address.city as string) ?? null,
    neighborhood: (address.neighborhood as string) ?? null,
    state: (address.state as string) ?? null,
  };

  const result = computeVisitScore(inputs, classesAtivas);

  const score_breakdown = {
    inputs: {
      churn_risk: inputs.churn_risk,
      expansion_score: inputs.expansion_score,
      health_score: inputs.health_score,
      recover_score: inputs.recover_score,
      days_since_last_purchase: inputs.days_since_last_purchase,
      days_since_last_visit: inputs.days_since_last_visit,
      sales_orders_count: inputs.sales_orders_count,
      sales_history_status: inputs.sales_history_status,
      is_prospect: inputs.is_prospect,
      prospect_source: inputs.prospect_source,
      revenue_potential: inputs.revenue_potential,
      avg_monthly_spend_180d: inputs.avg_monthly_spend_180d,
    },
    signal_modifiers_summary: {
      churn_count: inputs.signal_modifiers?.breakdown?.churn?.length ?? 0,
      expansion_count: inputs.signal_modifiers?.breakdown?.expansion?.length ?? 0,
      source_call_count: inputs.signal_modifiers?.source_call_count ?? 0,
    },
    mission_scores: result.scores,
    // Insumos ausentes da missão VENCEDORA — vazio só significa que ELA foi medida por
    // completo, não diz nada sobre as outras 3. Espelha VisitScore.insumos_ausentes de
    // src/lib/visit-scoring/types.ts.
    insumos_ausentes: result.insumos_ausentes,
  };

  const { error: upsertErr } = await supabase.from('customer_visit_scores').upsert({
    customer_user_id,
    farmer_id,
    // .score grava o null DE VERDADE quando a missão não foi avaliada — as colunas são
    // nullable (sem NOT NULL na migration 20260518120000_visit_intelligence_v1). Fabricar 0
    // aqui reintroduziria exatamente o que este PR remove.
    recuperacao_score: result.scores.recuperacao.score,
    expansao_score: result.scores.expansao.score,
    relacionamento_score: result.scores.relacionamento.score,
    prospeccao_score: result.scores.prospeccao.score,
    visit_score: result.visit_score,
    primary_mission: result.primary_mission,
    city: inputs.city,
    neighborhood: inputs.neighborhood,
    state: inputs.state,
    last_visit_at: lastVisitAt,
    days_since_last_visit: inputs.days_since_last_visit,
    score_breakdown,
    calculated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'customer_user_id' });

  if (upsertErr) return { ok: false, error: `upsert: ${upsertErr.message}` };

  return { ok: true, visit_score: result.visit_score, primary_mission: result.primary_mission };
}

// =====================================================
// --- Main handler ---
// =====================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // Sonda de versão (M-26; docs/agent/deploy.md): `{ probe: true }` responde a versão no ar sem
  // tocar banco nem Omie. `classificarSonda` decide fail-closed — a string "true" do SQL Editor é
  // ambígua e recebe 400, nunca cai no fluxo real. Corpo lido UMA vez e reaproveitado abaixo.
  const corpoBruto: Record<string, unknown> = await req.json().catch(() => ({}));
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") {
    return new Response(JSON.stringify(respostaSonda(VERSAO)), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (decisaoSonda.tipo === "ambiguo") {
    return new Response(JSON.stringify({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const body = corpoBruto as RecalcRequest;

  // Drain mode
  if (body.drain_queue) {
    const { data: pending, error } = await supabase
      .from('visit_score_recalc_pending')
      .select('id, customer_user_id, farmer_id')
      .limit(body.max_drain ?? 50);
    if (error) return jsonError(`pending: ${error.message}`, 500);

    // Drain CONCORRENTE (codex 2026-05-24): o backfill da carteira inteira passa pela fila.
    // recalcOne faz 5 queries/cliente, então o dreno sequencial estouraria 50s em lotes grandes.
    // Chunks de 10 → ~50 queries em voo; max_drain ~500 cabe no timeout.
    const queue = (pending ?? []) as Array<{ id: string; customer_user_id: string; farmer_id: string }>;
    const CONCURRENCY = 10;
    const results: Array<{ id: string; ok: boolean; error?: string; visit_score?: number; primary_mission?: MissionType }> = [];
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const chunk = queue.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map(async (item) => {
        let r: { ok: boolean; error?: string; visit_score?: number; primary_mission?: MissionType };
        try {
          r = await recalcOne(supabase, item.customer_user_id, item.farmer_id);
        } catch (err) {
          r = { ok: false, error: `uncaught: ${err instanceof Error ? err.message : String(err)}` };
        }
        // Always mark processed (even on uncaught error) — avoids poison-pill
        await supabase.from('visit_score_recalc_queue').update({
          processed_at: new Date().toISOString(),
          error: r.error ?? null,
        }).eq('id', item.id);
        return { id: item.id, ...r };
      }));
      results.push(...chunkResults);
    }

    return new Response(JSON.stringify({ drained: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Single mode
  if (!body.customer_user_id) {
    return jsonError('customer_user_id obrigatorio (ou drain_queue=true)', 400);
  }

  // Dono do score (scanner Lovable 2026-11-13, "staff can change another customer's visit
  // scores"): o `farmer_id` do corpo só é aceito de cron/service_role — o batch já o resolve de
  // carteira_assignments. Para STAFF ele é IGNORADO e o dono vem da carteira, senão um employee
  // reatribui o score de qualquer cliente a quem quiser e mexe no roteiro do vendedor.
  let farmerId: string | undefined = body.farmer_id;
  if (auth.via === 'staff') {
    const { data: dono, error: donoErr } = await supabase
      .from('carteira_assignments')
      .select('owner_user_id')
      .eq('customer_user_id', body.customer_user_id)
      .maybeSingle();
    if (donoErr) return jsonError('falha ao ler o dono da carteira', 500);
    if (!dono?.owner_user_id) return jsonError('cliente sem dono na carteira', 422);
    farmerId = dono.owner_user_id;
  }
  if (!farmerId) {
    return jsonError('farmer_id obrigatorio para cron/service_role', 400);
  }

  const r = await recalcOne(supabase, body.customer_user_id, farmerId);
  return new Response(JSON.stringify(r), {
    status: r.error ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
