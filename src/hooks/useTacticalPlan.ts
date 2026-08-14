import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { selectObjective, clampRecencyCapDays, objetivoFinal } from '@/lib/scoring/objective';
import { margemConhecida, mediaMargensConhecidas, valorMedido } from '@/lib/scoring/margin';
import { numerosDoBundle } from '@/lib/tactical/bundle-numeros';
import { ehJaGeradoHoje } from '@/lib/tactical/plano-duplicata';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { eventoDaCarga, type SaidaDaCarga } from '@/lib/tactical/telemetria-fila-plano';
import { track } from '@/lib/analytics';
import { fetchAllPages } from '@/lib/postgrest';
import { ownersAtivosDoAlvo } from '@/lib/carteira/escopo-clientes';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────────────
export type PlanType = 'essencial' | 'estrategico';

// JSON shape stored in top_bundle / second_bundle columns — schema is dynamic
// (varies by bundle engine version), so kept as Record.
export type BundleSnapshot = Record<string, unknown>;

export interface TacticalPlan {
  id: string;
  customerId: string;
  customerName: string;
  planType: PlanType;

  // Diagnosis
  healthScore: number;
  churnRisk: number;
  mixGap: number;
  /** PERCENTUAL (0–100), ou null quando a margem era desconhecida na geração do plano. */
  currentMarginPct: number | null;
  clusterAvgMarginPct: number | null;
  /** PERCENTUAL, ou null quando o potencial não foi medido — hoje, 100% da base
   *  (farmer_client_scores.expansion_score é NULL em 6.633/6.633; nenhum writer o calcula). */
  expansionPotential: number | null;

  // Strategy
  strategicObjective: string;
  customerProfile: string;
  approachStrategy: string;
  approachStrategyB: string;

  // Bundle
  // Campos NULLABLE por dado (money-path — ausente ≠ zero): `null` = não havia bundle
  // prioritário na geração do plano, ou a coluna de origem não estava medida. Eram
  // `number` e o `Number(x || 0)` da leitura fabricava 0 — "LIE R$ 0,00" e "Probabilidade
  // 0,0%" leem como veredito comercial apurado. ⚠️ Em comparação relacional o guard
  // `!= null` é obrigatório: `null > 0` é `false` por coerção, o que aqui até esconde a
  // seção (desejável), mas `null < x` seria `true` — não reintroduza o padrão sem checar.
  topBundle: BundleSnapshot;
  secondBundle: BundleSnapshot;
  bundleLie: number | null;
  bundleProbability: number | null;
  bundleIncrementalMargin: number | null;
  /** Nunca medido: nenhum writer do repo o calcula (era `0` hardcoded nos dois). */
  bestIndividualLie: number | null;

  // AI-generated content
  diagnosticQuestions: { question: string; purpose: string; expected_insight: string }[];
  implicationQuestion: string;
  offerTransition: string;
  // `probability` é OPCIONAL: a edge omite o campo quando a IA não soube estimar.
  // Tipá-la como `number` obrigatório fazia o TS garantir um número que o dado não tem.
  probableObjections: { objection: string; technical_response: string; economic_response: string; probability?: number | null }[];

  // Strategic-only fields
  // Campos NULLABLE por dado: margem/LTV não medidos chegam como null (money-path —
  // ausente ≠ zero). O objeto pode vir PARCIALMENTE medido, então o guard `&& (...)`
  // do PlanCard não basta: cada campo é null-checado na renderização.
  ltvProjection: { current_annual: number | null; projected_annual: number | null; growth_pct: number | null } | null;
  expectedResult: { best_case_margin: number | null; likely_margin: number | null; worst_case_margin: number | null } | null;
  operationalRisks: string[];

  // Efficiency
  /** Derivado do LIE do bundle. `null` = indecidível (não há LIE), não "R$ 0/h". */
  estimatedProfitPerHour: number | null;

  // Tracking
  status: string;
  planFollowed?: boolean;
  callResult?: string;
  actualMargin?: number;
  callDurationSeconds?: number;
  objectionType?: string;
  notes?: string;
  generatedAt: string;
}

// ─── Row + helper types ────────────────────────────────────────────
interface TacticalPlanRow {
  id: string;
  customer_user_id: string;
  plan_type: PlanType | null;
  health_score: number | string | null;
  churn_risk: number | string | null;
  mix_gap: number | string | null;
  current_margin_pct: number | string | null;
  cluster_avg_margin_pct: number | string | null;
  expansion_potential: number | string | null;
  strategic_objective: string;
  customer_profile: string;
  approach_strategy: string | null;
  approach_strategy_b: string | null;
  top_bundle: BundleSnapshot | null;
  second_bundle: BundleSnapshot | null;
  bundle_lie: number | string | null;
  bundle_probability: number | string | null;
  bundle_incremental_margin: number | string | null;
  best_individual_lie: number | string | null;
  diagnostic_questions: TacticalPlan['diagnosticQuestions'] | unknown;
  implication_question: string | null;
  offer_transition: string | null;
  probable_objections: TacticalPlan['probableObjections'] | unknown;
  ltv_projection: TacticalPlan['ltvProjection'] | unknown;
  expected_result: TacticalPlan['expectedResult'] | unknown;
  operational_risks: string[] | unknown;
  status: string;
  plan_followed?: boolean | null;
  call_result?: string | null;
  actual_margin?: number | string | null;
  call_duration_seconds?: number | null;
  objection_type?: string | null;
  notes?: string | null;
  generated_at: string;
}

interface ClientScoreFull {
  farmer_id: string | null; // dono da carteira-Omie (Opção A) — escopa o cluster de margem
  health_score: number | string | null;
  churn_risk: number | string | null;
  avg_monthly_spend_180d: number | string | null;
  gross_margin_pct: number | string | null;
  category_count: number | string | null;
  days_since_last_purchase: number | string | null;
  expansion_score: number | string | null;
  revenue_potential: number | string | null;
  sales_history_status: string | null;
}

interface ProfileLite {
  user_id?: string;
  name: string | null;
  customer_type?: string | null;
  cnae?: string | null;
}

interface BundleRow {
  id: string;
  bundle_products: BundleSnapshot;
  lie_bundle: number | string | null;
  p_bundle: number | string | null;
  m_bundle: number | string | null;
}

interface CopilotEventRow {
  event_data: { intent?: string } | Record<string, unknown> | null;
}

interface EffectivenessRow {
  strategic_objective: string;
  plan_followed: boolean | null;
  actual_margin: number | string | null;
  call_duration_seconds: number | string | null;
  plan_type: PlanType | null;
}

/**
 * Acumulador de efetividade. Cada total anda com o SEU denominador de apurados.
 *
 * [money-path — ausente ≠ zero] O registro de 1 toque grava `plan_followed`, `actual_margin` e
 * `call_duration_seconds` como NULL de propósito (afirma só o desfecho). Dividir pelo `count`
 * bruto — como fazia o `Number(d.actual_margin || 0) / count` — diluiria a média com planos que
 * ninguém mediu, e o número resultante seria lido como margem média real da carteira.
 */
interface AcumuladorEfetividade {
  count: number;
  followed: number;
  /** Quantos declararam adesão ao roteiro (true OU false). Denominador de `followRate`. */
  comFollow: number;
  totalMargin: number;
  comMargem: number;
  /**
   * Margem e tempo somados APENAS sobre os planos que têm os dois. R$/h derivado de um total de
   * margem e um total de tempo vindos de conjuntos diferentes não significa nada.
   */
  margemComTempo: number;
  tempoComMargem: number;
}

interface AiPlanResponse {
  strategic_objective?: string;
  diagnostic_questions?: TacticalPlan['diagnosticQuestions'];
  implication_question?: string;
  offer_transition?: string;
  probable_objections?: TacticalPlan['probableObjections'];
  approach_strategy?: string;
  approach_strategy_b?: string;
  ltv_projection?: TacticalPlan['ltvProjection'];
  expected_result?: TacticalPlan['expectedResult'];
  operational_risks?: string[];
}

interface DiagnosticData {
  strategicObjective: string;
  secondBundle?: {
    products: BundleSnapshot;
    lie: number | string | null;
    probability: number | string | null;
    margin: number | string | null;
  };
}

export interface EfficiencyCheck {
  /** `null` = R$/h indecidível (não é zero). Ver `motivo` para saber POR QUE. */
  estimatedProfitPerHour: number | null;
  threshold: number;
  /** `null` = indecidível. Não afirma que passou NEM que reprovou no gate. */
  isAboveThreshold: boolean | null;
  /**
   * Por que o R$/h é indecidível. `sem_margem` = o cliente não tem margem apurada — fato
   * sobre o dado dele. `indisponivel` = a consulta falhou (timeout, RLS, 500) e não sabemos
   * nada — afirmar "margem não apurada" aqui alegaria um fato sobre o cliente a partir de
   * uma falha nossa. Ausente quando o R$/h foi calculado.
   */
  motivo?: 'sem_margem' | 'indisponivel';
}

const objectiveLabels: Record<string, string> = {
  recuperacao: '🔴 Recuperação',
  expansao_mix: '🟢 Expansão de Mix',
  upsell_premium: '🔵 Up-sell Premium',
  reativacao: '🟡 Reativação',
  ativacao: '🆕 Ativação',
  consolidacao_margem: '🟠 Consolidação de Margem',
};

export const getObjectiveLabel = (obj: string) => objectiveLabels[obj] || obj;

// Espelho de classifyProfile em supabase/functions/_shared/tactical-margem.ts (e de
// classifyCustomerProfile em useBundleArguments.ts). ⚠️ Os dois primeiros ramos exigem margem
// CONHECIDA: `null < 20` é `true` em JS, então sem o guard todo cliente de gasto baixo e margem
// não apurada sairia como "sensível a preço" — e esse rótulo entra no prompt da IA.
const classifyProfile = (healthScore: number, avgSpend: number, marginPct: number | null, categoryCount: number): string => {
  const m = margemConhecida(marginPct);
  if (m != null && avgSpend < 500 && m < 20) return 'sensivel_preco';
  if (m != null && m > 35 && categoryCount <= 3) return 'orientado_qualidade';
  if (avgSpend > 2000 && categoryCount >= 4 && healthScore > 60) return 'orientado_produtividade';
  return 'misto';
};

const PROFIT_PER_HOUR_THRESHOLD = 50; // R$/h configurable threshold

/**
 * Janela da fila de pendentes, em dias. Espelha o argumento do cron
 * `expirar-planos-taticos` (migration `20260807210912`), que marca `expirado`
 * fora dela. O front aplica a MESMA janela em vez de confiar que o job rodou:
 * se o cron falhar, a fila voltaria a entupir e o plano some sem desfecho.
 */
export const JANELA_FILA_DIAS = 7;

/** Teto de cards por carga. Não é paginação — é o tamanho do lote acionável. */
export const LIMITE_FILA = 50;

export type FiltroFila = 'pendentes' | 'concluidos' | 'expirados';

/**
 * Recorte da fila. Extraído para que a LISTA e a CONTAGEM usem exatamente o
 * mesmo predicado — se divergirem, o contador da tela mente sobre quantos
 * planos existem além dos exibidos, que é justamente o número que este PR
 * passou a mostrar.
 */
function recorteDaFila<Q extends { eq: (c: string, v: string) => Q; gte: (c: string, v: string) => Q }>(
  q: Q,
  filtro: FiltroFila,
  desdeIso: string,
): Q {
  if (filtro === 'concluidos') return q.eq('status', 'concluido');
  if (filtro === 'expirados') return q.eq('status', 'expirado');
  return q.eq('status', 'gerado').gte('generated_at', desdeIso);
}

export const useTacticalPlan = () => {
  const { user } = useAuth();
  // Lente "Ver como" + COBERTURA (#980): as leituras de EXIBIÇÃO (lista de planos, plano ativo do
  // cliente) seguem a VISIBILIDADE de carteira do id efetivo — carteira própria + carteiras
  // cobertas (fetchOwnerScope/ownersAtivosDoAlvo). O id efetivo é o ALVO na lente, o próprio
  // usuário fora. ⚠️ A RLS de farmer_tactical_plans é BROAD-STAFF (`tactical_plans_select_staff`:
  // master OR employee) — NÃO recorta por cliente nem por farmer_id, então TODO o escopo de leitura
  // é responsabilidade do app. O que a fecha hoje é a ESCRITA (#1422: RPC + trigger recusam cliente
  // mascarado, e a tabela não é escrevível fora das RPCs) ⇒ não existe plano de mascarado para vazar.
  // Estreitar a policy p/ carteira-scoped ficou como follow-up com desenho próprio: a carteira é
  // VIVA, então um cliente reatribuído sumiria retroativamente da métrica de performance do dono
  // anterior. A GERAÇÃO (checkEfficiency/generatePlan) e o
  // registro de resultado seguem user.id (write identity = master real) e são bloqueados na lente
  // pelo write-guard + botões disabled. A POSSE gravada (farmer_id) é o DONO da carteira do cliente
  // (score.farmer_id), nunca o executor. Fora da lente effectiveUserId === user.id.
  const { effectiveUserId } = useImpersonation();
  const [plans, setPlans] = useState<TacticalPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  /** Total que casa o filtro atual (pode exceder LIMITE_FILA). `null` = não apurado. */
  const [totalNaFila, setTotalNaFila] = useState<number | null>(null);
  // Último recorte pedido. `generatePlan`/`recordResult` recarregam a lista sem saber
  // qual aba está aberta; sem este ref o default os jogaria de volta em `pendentes` e
  // a lista passaria a discordar da aba selecionada. Ref (não state): só alimenta o
  // default da próxima carga, não deve disparar render.
  const filtroAtual = useRef<FiltroFila>('pendentes');

  const parsePlan = (d: TacticalPlanRow, profileMap: Map<string, string>): TacticalPlan => {
    const topBundle: BundleSnapshot = d.top_bundle || {};
    const secondBundle: BundleSnapshot = d.second_bundle || {};
    const ltvProjection = d.ltv_projection;
    const expectedResult = d.expected_result;
    const avgCallMinutes = 15;
    // [money-path "ausente ≠ zero"] A LEITURA é a metade que faltava: corrigir só os dois
    // writers deixaria a correção INERTE (money-path.md §2) — o null gravado voltaria a
    // virar 0 aqui, e a tela continuaria afirmando "LIE R$ 0,00". Agora o tri-estado
    // atravessa o parse até o card.
    const bundleLie = valorMedido(d.bundle_lie);
    // Sem LIE o R$/h é INDECIDÍVEL, não zero — mesmo tri-estado de `checkEfficiency`.
    // `0` medido continua sendo 0 (bundle apurado que não agrega lucro na ligação).
    const estimatedProfitPerHour = bundleLie == null
      ? null
      : (bundleLie > 0 ? bundleLie / (avgCallMinutes / 60) : 0);

    return {
      id: d.id,
      customerId: d.customer_user_id,
      customerName: profileMap.get(d.customer_user_id) || 'Cliente',
      planType: d.plan_type || 'essencial',
      healthScore: Number(d.health_score || 0),
      churnRisk: Number(d.churn_risk ?? 0), // ?? (não ||): churn=0 é valor real (cliente saudável), não ausência
      mixGap: Number(d.mix_gap || 0),
      // O plano persistido grava a margem do cliente no INSTANTE da geração; pós-#1495 ela
      // pode ser null, e `Number(null || 0)` a exibiria como "0,0%" — margem nula apurada.
      currentMarginPct: margemConhecida(d.current_margin_pct),
      clusterAvgMarginPct: d.cluster_avg_margin_pct == null ? null : Number(d.cluster_avg_margin_pct),
      // Mesma razão do currentMarginPct logo acima, e o irmão que ficou para trás: o plano
      // persistido pode ter gravado null (potencial não medido na geração), e
      // `Number(null || 0)` o exibiria como "0%" — um veredito de "cliente sem espaço para
      // crescer" que ninguém apurou. A coluna expansion_potential é nullable em prod.
      expansionPotential: valorMedido(d.expansion_potential),
      strategicObjective: d.strategic_objective,
      customerProfile: d.customer_profile,
      approachStrategy: d.approach_strategy || '',
      approachStrategyB: d.approach_strategy_b || '',
      topBundle,
      secondBundle,
      bundleLie,
      bundleProbability: valorMedido(d.bundle_probability),
      bundleIncrementalMargin: valorMedido(d.bundle_incremental_margin),
      bestIndividualLie: valorMedido(d.best_individual_lie),
      diagnosticQuestions: Array.isArray(d.diagnostic_questions)
        ? (d.diagnostic_questions as TacticalPlan['diagnosticQuestions'])
        : [],
      implicationQuestion: d.implication_question || '',
      offerTransition: d.offer_transition || '',
      probableObjections: Array.isArray(d.probable_objections)
        ? (d.probable_objections as TacticalPlan['probableObjections'])
        : [],
      ltvProjection: ltvProjection && typeof ltvProjection === 'object'
        ? (ltvProjection as TacticalPlan['ltvProjection'])
        : null,
      expectedResult: expectedResult && typeof expectedResult === 'object'
        ? (expectedResult as TacticalPlan['expectedResult'])
        : null,
      operationalRisks: Array.isArray(d.operational_risks) ? (d.operational_risks as string[]) : [],
      estimatedProfitPerHour,
      status: d.status,
      planFollowed: d.plan_followed ?? undefined,
      callResult: d.call_result ?? undefined,
      // [money-path] `d.actual_margin ? … : undefined` era o `|| 0` ESPELHADO: aqui o número
      // MEDIDO é que se perdia — margem 0 apurada (ligação que fechou sem margem, ou desconto
      // total) caía no ramo falso e virava "não registrado". Só `null`/`undefined` é ausência.
      actualMargin: d.actual_margin == null ? undefined : Number(d.actual_margin),
      callDurationSeconds: d.call_duration_seconds ?? undefined,
      objectionType: d.objection_type ?? undefined,
      notes: d.notes ?? undefined,
      generatedAt: d.generated_at,
    };
  };

  // Visibilidade de carteira p/ LEITURA: dono efetivo + carteiras que ele cobre (cobertura ativa e
  // dentro da validade). Reproduz, com a sessão atual, o que carteira_visivel_para daria — preciso
  // porque a RLS de farmer_tactical_plans é BROAD-STAFF (master OR employee): ela não separa por
  // DONO nem por CLIENTE, então este filtro é a única barreira de escopo na leitura.
  // baseId = effectiveUserId (alvo na lente, próprio fora).
  const fetchOwnerScope = useCallback(async (baseId: string): Promise<string[]> => {
    const { data: cov, error } = (await supabase
      .from('carteira_coverage')
      .select('covered_user_id, valid_until')
      .eq('covering_user_id', baseId)
      .eq('active', true)) as unknown as { data: { covered_user_id: string; valid_until: string | null }[] | null; error: unknown };
    // Erro na cobertura degrada para [próprio] (fail-closed: não vaza carteira alheia) mas NÃO
    // silencioso — senão "a cobertura sumiu" passa despercebido (achado /codex challenge P2).
    if (error) console.error('fetchOwnerScope: falha lendo carteira_coverage; escopo cai p/ próprio', error);
    return ownersAtivosDoAlvo(cov ?? [], baseId, new Date().toISOString());
  }, []);

  // Load existing plans
  const loadPlans = useCallback(async (filtro: FiltroFila = filtroAtual.current) => {
    // [SENSOR] Telemetria do DESFECHO da carga (docs/historico/fila-plano-tatico.md). Três das
    // quatro saídas desta função produzem o MESMO pixel na tela — "Nenhum plano pendente" — e a
    // quarta deixa a lista ANTIGA no lugar. Sem declarar o motivo em cada uma, "a consulta
    // morreu" fica indistinguível de "não há plano", que é fabricar diagnóstico.
    // `total` acompanha o que a carga JÁ apurou: null até a contagem responder, para que
    // nenhum evento afirme um denominador que aquele ponto do código ainda não tinha.
    let total: number | null = null;
    const emitir = (saida: SaidaDaCarga) => {
      const ev = eventoDaCarga(saida, { filtro, total });
      track(ev.evento, ev.props);
    };

    if (!effectiveUserId) {
      // Hoje inalcançável POR ESTA TELA (useFarmerTacticalPlan gateia por `user?.id`, e
      // `effectiveUserId` deriva do mesmo `user`). Instrumentado mesmo assim: se outro chamador
      // aparecer, a saída fica visível em vez de silenciosa — e ela nem liga o `loading`.
      emitir({ tipo: 'vazia', motivo: 'sem_escopo' });
      return;
    }
    filtroAtual.current = filtro;
    setLoading(true);
    try {
      const owners = await fetchOwnerScope(effectiveUserId);
      const desdeIso = new Date(Date.now() - JANELA_FILA_DIAS * 86_400_000).toISOString();

      // Ordena por RISCO, não por recência. `churn_risk` tem 53 valores distintos entre
      // 33 e 89 nas 533 linhas de prod — discrimina de verdade. `bundle_lie` e
      // `best_individual_lie` seriam o critério natural de VALOR, mas estão NULL em 100%
      // das linhas (medido 2026-08-07): ordenar por eles seria ordem indefinida
      // disfarçada de priorização. `generated_at` desempata (churn_risk tem empates
      // massivos e, sem ordem total, a fatia de 50 é instável entre cargas).
      // [SENSOR] O `error` desta consulta era DESCARTADO no destructuring, e `!data` caía no
      // mesmo `setPlans([])` de uma fila legitimamente vazia. Ele agora é lido — só para
      // DECLARAR o motivo na telemetria; o que a tela renderiza é idêntico ao de antes.
      const { data, error: erroLista } = (await recorteDaFila(
        supabase.from('farmer_tactical_plans').select('*').in('farmer_id', owners),
        filtro,
        desdeIso,
      )
        .order('churn_risk', { ascending: false })
        .order('generated_at', { ascending: false })
        .limit(LIMITE_FILA)) as unknown as { data: TacticalPlanRow[] | null; error: unknown };

      // Contagem sob o MESMO recorte. Sem ela a tela não tem como avisar que existe
      // plano além dos exibidos — foi exatamente assim que 383 de 533 sumiram sem
      // deixar rastro nenhum na interface.
      const { count, error: erroContagem } = (await recorteDaFila(
        supabase
          .from('farmer_tactical_plans')
          .select('id', { count: 'exact', head: true })
          .in('farmer_id', owners),
        filtro,
        desdeIso,
      )) as unknown as { count: number | null; error: unknown };
      // ausente ≠ zero: contagem que falhou degrada para `null` (a UI omite o rótulo),
      // nunca para 0 — "0 pendentes" é indistinguível de "a query morreu", e some com
      // a fila inteira sem sinal. Mesma família do `Number(null) === 0`.
      setTotalNaFila(erroContagem ? null : (count ?? null));
      total = erroContagem ? null : (count ?? null);

      // [SENSOR] O ERRO TEM PRECEDÊNCIA SOBRE `data`. As duas saídas abaixo faziam exatamente
      // o mesmo `setPlans([]); return;` — e continuam fazendo, byte por byte, do ponto de vista
      // da tela. O que mudou é que agora elas se DECLARAM: falha de consulta é `fila_erro`,
      // e resposta sem `data` e sem `error` é indecidível assumida, não um palpite entre as duas.
      if (erroLista) {
        setPlans([]);
        emitir({ tipo: 'erro', origem: 'consulta', mensagem: mensagemDeErro(erroLista), manteveLista: false });
        return;
      }
      if (!data) {
        setPlans([]);
        emitir({ tipo: 'vazia', motivo: 'sem_resposta' });
        return;
      }

      const customerIdsSet = new Set<string>();
      data.forEach((d) => customerIdsSet.add(String(d.customer_user_id)));
      const customerIds: string[] = Array.from(customerIdsSet);
      const { data: profiles } = (await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', customerIds)) as unknown as { data: ProfileLite[] | null };

      const profileMap = new Map<string, string>(
        (profiles || []).map((p) => [p.user_id ?? '', p.name ?? 'Cliente'])
      );
      setPlans(data.map((d) => parsePlan(d, profileMap)));
      emitir({ tipo: 'lista', nExibidos: data.length });
    } catch (err) {
      console.error('Error loading plans:', err);
      // [SENSOR] `manteveLista: true` porque este catch NÃO toca em `plans`: a tela continua
      // exibindo o retrato do carregamento anterior como se fosse o atual. É a diferença entre
      // "quebrou e esvaziou" e "quebrou e está mentindo em silêncio" — e ela só existe no dado
      // se for declarada aqui.
      emitir({ tipo: 'erro', origem: 'excecao', mensagem: mensagemDeErro(err), manteveLista: true });
    } finally {
      setLoading(false);
    }
  }, [effectiveUserId, fetchOwnerScope]);

  // Check efficiency before generating
  const checkEfficiency = useCallback(async (customerId: string): Promise<EfficiencyCheck> => {
    // Sem sessão também é "não avaliei", não "reprovou" — mesmo tri-estado do resto.
    if (!user?.id) return { estimatedProfitPerHour: null, threshold: PROFIT_PER_HOUR_THRESHOLD, isAboveThreshold: null, motivo: 'indisponivel' };

    const { data: score, error: erroScore } = (await supabase
      .from('farmer_client_scores')
      .select('revenue_potential, avg_monthly_spend_180d, gross_margin_pct')
      // Opção A: 1 linha por cliente (customer_user_id único). NÃO filtrar por farmer_id —
      // quebrava sob a lente / cliente de outro dono → "sem score" falso; RLS gateia a visibilidade.
      .eq('customer_user_id', customerId)
      .single()) as unknown as {
        data: Pick<ClientScoreFull, 'revenue_potential' | 'avg_monthly_spend_180d' | 'gross_margin_pct'> | null;
        error: unknown };

    // FALHA DE CONSULTA ≠ MARGEM NÃO APURADA. O `error` era descartado, então timeout/RLS/500
    // caíam no mesmo indecidível do cliente sem margem — e o diálogo então AFIRMA a causa
    // errada à vendedora, que pode acionar o financeiro por um cadastro de custo que existe.
    // Os dois estados são indistinguíveis pelos campos numéricos; só `motivo` os separa.
    if (erroScore || !score) {
      return { estimatedProfitPerHour: null, threshold: PROFIT_PER_HOUR_THRESHOLD, isAboveThreshold: null, motivo: 'indisponivel' };
    }

    // Tri-estado explícito: revenue_potential é NULL em 6.633/6.633 linhas (nenhum writer o
    // calcula). O `|| 0` anterior transformava "não medido" em `0` e só não fabricava número
    // por ACIDENTE — o `> 0 ?` logo abaixo o mandava para o avgSpend. Acidente não é guard: no
    // dia em que um produtor gravar potencial 0 APURADO, o código o trataria como ausência.
    const revPotential = valorMedido(score.revenue_potential);
    const avgSpend = Number(score.avg_monthly_spend_180d || 0);
    // Margem desconhecida → R$/h INDECIDÍVEL, não zero. Com `|| 0` o gate reprovava o cliente por
    // omissão, e "não sei" ficava indistinguível de "não vale a ligação" na tela da vendedora.
    // Espelha profitPerHora de supabase/functions/_shared/tactical-margem.ts.
    const marginPct = margemConhecida(score.gross_margin_pct);
    const avgCallMinutes = 15;
    // Base do cálculo: o potencial quando MEDIDO e positivo; senão o gasto médio observado.
    // Potencial ausente e potencial 0 caem ambos no avgSpend — comportamento PRESERVADO desta
    // entrega (só o `|| 0` saiu), agora por decisão declarada em vez de coincidência aritmética.
    const baseReceita = revPotential != null && revPotential > 0 ? revPotential : avgSpend;
    const estimatedProfitPerHour = marginPct == null
      ? null
      : (baseReceita * (marginPct / 100) * 0.1) / (avgCallMinutes / 60);

    return {
      estimatedProfitPerHour,
      threshold: PROFIT_PER_HOUR_THRESHOLD,
      // null → não afirma que passou NEM que reprovou; quem exibe decide como mostrar "sem dado".
      isAboveThreshold: estimatedProfitPerHour == null
        ? null
        : estimatedProfitPerHour >= PROFIT_PER_HOUR_THRESHOLD,
      // Chegou aqui ⇒ a consulta funcionou. Indecidível agora só pode ser ausência de margem.
      ...(estimatedProfitPerHour == null ? { motivo: 'sem_margem' as const } : {}),
    };
  }, [user]);

  // Generate plan for a customer
  const generatePlan = useCallback(async (customerId: string, planType: PlanType = 'essencial') => {
    if (!user?.id) return;
    setGenerating(customerId);

    try {
      const [
        { data: score },
        { data: profile },
        { data: recencyCapRow },
      ] = await Promise.all([
        // Opção A: lookup por customer_user_id (único); sem farmer_id (RLS gateia). Ver checkEfficiency.
        supabase.from('farmer_client_scores').select('*').eq('customer_user_id', customerId).single() as unknown as Promise<{ data: ClientScoreFull | null }>,
        supabase.from('profiles').select('name, customer_type, cnae').eq('user_id', customerId).single() as unknown as Promise<{ data: ProfileLite | null }>,
        // Teto de recência (hs_recency_cap_days) — fronteira reativacao/recuperacao em selectObjective
        // ACOMPANHA o teto do modelo (não hardcode). Ausente → clampRecencyCapDays default 180. limit(1)
        // pra maybeSingle nunca lançar em chave duplicada (não quebrar a geração por quirk de config).
        supabase.from('farmer_algorithm_config').select('value').eq('key', 'hs_recency_cap_days').limit(1).maybeSingle() as unknown as Promise<{ data: { value: number | string | null } | null }>,
      ]);

      if (!score) {
        toast.error('Cliente sem score calculado');
        return;
      }

      // [GUARD money-path] POSSE do plano = DONO da carteira do cliente (score.farmer_id, Opção A),
      // NUNCA o executor logado. A RLS de farmer_tactical_plans é broad-staff (não escopa por
      // farmer_id), então o campo é o ÚNICO mecanismo de posse: gravar user.id poluiria a carteira
      // do gestor sob cobertura (#980) e sumiria da carteira do dono. O bundle (multi por
      // (customer,farmer)) e o cluster também escopam pelo dono. farmer_id null = corrupção →
      // precisão>recall: abortar (não gravar sob dono errado, não cair pro viewer, não fabricar).
      const ownerId = score.farmer_id;
      if (!ownerId) {
        toast.error('Cliente sem dono de carteira definido — não é possível gerar o plano');
        return;
      }

      const healthScore = Number(score.health_score || 0);
      const churnRisk = Number(score.churn_risk ?? 0); // ?? (não ||): churn=0 é valor real, não ausência
      const avgSpend = Number(score.avg_monthly_spend_180d || 0);
      const marginPct = margemConhecida(score.gross_margin_pct);
      const categoryCount = Number(score.category_count || 0);
      const daysSince = Number(score.days_since_last_purchase || 0);
      // [money-path "ausente ≠ zero"] Espelha a edge generate-tactical-plan: estas duas colunas
      // foram nuladas de propósito (20260727130000_farmer_scores_colunas_orfas_null) porque
      // nenhum writer as calcula — 6.633/6.633 NULL em prod, `column_default` removido. Com
      // `|| 0` os dois campos chegavam ao prompt como `0` para TODA a base, e o system prompt
      // instrui a IA a ler número como MEDIDO: "revenuePotential: 0" afirma "cliente sem
      // potencial" e muda a abordagem que a vendedora leva para a rua. Nenhum dos dois entra
      // em comparação relacional daqui para baixo (só no prompt e no payload, ambos nullable),
      // então o tri-estado não reabre a armadilha do `null < x`.
      const expansionPotential = valorMedido(score.expansion_score);
      const revenuePotential = valorMedido(score.revenue_potential);
      const salesHistoryStatus = score.sales_history_status ?? null;

      // [GUARD money-path] Cluster = média de margem dos PARES da carteira do DONO (ownerId), não
      // de quem está logado. Sob cobertura (#980) o viewer gera plano de cliente de OUTRO dono;
      // benchmarkar por user.id daria cluster errado e, p/ gestor sem carteira, fabricava 25
      // (margem<20 forçando consolidacao a esmo). A RLS fcs_select_carteira deixa o cobridor ler a
      // carteira do coberto (carteira_visivel_para via carteira_coverage). Exclui o próprio cliente
      // (peer benchmark) e exige ≥1 par com margem finita; sem par → null (selectObjective trata;
      // nada de 25).
      // [GUARD money-path] PAGINADO. A consulta era single-shot e o PostgREST capa em 1.000
      // linhas em SILÊNCIO. Medido em prod (psql-ro, 2026-07-21): os três farmers têm 3.858,
      // 1.528 e 1.246 clientes — TODOS truncavam, o maior deles enxergando 26% dos pares.
      // Isso importa mais aqui do que numa lista qualquer: o cluster é a RÉGUA contra a qual a
      // margem do cliente é julgada (`margem < cluster * 0.8` → consolidacao_margem), então a
      // truncagem não some um cliente da tela — ela move a régua e troca o VEREDITO, de forma
      // plausível e silenciosa. Ordem por `customer_user_id` (UNIQUE): sem ordem estável a
      // paginação pula e repete linha entre páginas.
      let clusterMargin: number | null = null;
      {
        // Falha de página REJEITA — garantido pelo contrato de `fetchAllPages`, não por guard
        // local (o guard que vivia aqui virou redundante quando o helper passou a exigir
        // `error` e falhar alto; duas camadas fazendo a mesma coisa só escondem qual vale).
        // Importa especialmente aqui: a régua decide entre `upsell_premium` e
        // `consolidacao_margem`, entra no prompt da IA e fica gravada no plano — um cluster
        // calculado sobre páginas faltantes troca o VEREDITO de forma plausível e silenciosa.
        const peers = await fetchAllPages<Pick<ClientScoreFull, 'gross_margin_pct'>>((de, ate) =>
          supabase
            .from('farmer_client_scores')
            .select('gross_margin_pct')
            .eq('farmer_id', ownerId)
            .neq('customer_user_id', customerId)
            .order('customer_user_id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{
            data: Pick<ClientScoreFull, 'gross_margin_pct'>[] | null;
            error: unknown;
          }>,
          'farmer_client_scores/cluster-margem',
        );
        clusterMargin = mediaMargensConhecidas(peers.map((r) => r.gross_margin_pct));
      }

      // Bundle pendente do cliente sob a carteira do DONO (ownerId), não do viewer. A tabela é
      // multi por (customer_user_id, farmer_id) — NÃO basta dropar o farmer_id (traria bundle de
      // outro dono); filtrar pelo dono é o correto. A RLS fbrec_select_carteira deixa o cobridor
      // ler via carteira_visivel_para. limit(2): top + second p/ o plano estratégico.
      const { data: bundles } = (await supabase
        .from('farmer_bundle_recommendations')
        .select('*')
        .eq('customer_user_id', customerId)
        .eq('farmer_id', ownerId)
        .eq('status', 'pendente')
        .order('lie_bundle', { ascending: false })
        .limit(2)) as unknown as { data: BundleRow[] | null };

      const mixGap = Math.max(0, 8 - categoryCount);
      const customerProfile = classifyProfile(healthScore, avgSpend, marginPct, categoryCount);
      const recencyCapDays = clampRecencyCapDays(recencyCapRow?.value);
      const strategicObjective = selectObjective(churnRisk, mixGap, marginPct, clusterMargin, daysSince, recencyCapDays, salesHistoryStatus);

      const topBundle = bundles?.[0] || null;
      const secondBundle = bundles?.[1] || null;

      const { data: objectionEvents } = (await supabase
        .from('farmer_copilot_events')
        .select('event_data')
        .eq('event_type', 'suggestion')
        .limit(20)) as unknown as { data: CopilotEventRow[] | null };

      const historicalObjections = (objectionEvents || [])
        .filter((e): e is CopilotEventRow & { event_data: { intent: string } } => {
          const intent = (e.event_data as { intent?: unknown } | null)?.intent;
          return typeof intent === 'string' && intent.startsWith('objecao');
        })
        .map((e) => e.event_data.intent)
        .slice(0, 5);

      const bundleCtx = topBundle ? {
        products: topBundle.bundle_products,
        lie: topBundle.lie_bundle,
        probability: topBundle.p_bundle,
        margin: topBundle.m_bundle,
      } : null;

      // For strategic plans, include second bundle for comparison
      const diagnosticData: DiagnosticData = { strategicObjective };
      if (planType === 'estrategico' && secondBundle) {
        diagnosticData.secondBundle = {
          products: secondBundle.bundle_products,
          lie: secondBundle.lie_bundle,
          probability: secondBundle.p_bundle,
          margin: secondBundle.m_bundle,
        };
      }

      // invokeFunction (e não supabase.functions.invoke cru) porque o erro do
      // supabase é sempre o genérico "non-2xx status code": o motivo REAL da
      // edge — créditos esgotados, geração truncada — vem no corpo e só o
      // helper o extrai. Com o invoke cru, o estouro de orçamento que motivou
      // a migração continuaria invisível para quem usa.
      const aiPlan = await invokeFunction<AiPlanResponse>('generate-tactical-plan', {
          customerContext: {
            name: profile?.name,
            cnae: profile?.cnae,
            customerType: profile?.customer_type,
            profile: customerProfile,
            healthScore,
            churnRisk,
            avgMonthlySpend: avgSpend,
            grossMarginPct: marginPct,
            categoryCount,
            daysSinceLastPurchase: daysSince,
            mixGap,
            clusterAvgMargin: clusterMargin,
            expansionPotential,
            revenuePotential,
            salesHistoryStatus,
          },
          bundleContext: bundleCtx,
          diagnosticData,
          historicalObjections,
          planType,
      });

      // Escrita via RPC-fronteira (#1037 + split de RLS): a posse (farmer_id) é re-resolvida
      // server-side de carteira_assignments e a RLS pós-split NEGA insert direto do client.
      // _expected_owner=ownerId faz a RPC ABORTAR se a carteira foi reatribuída durante a
      // geração da IA (race) em vez de gravar o dono stale; farmer_id/customer_user_id/status
      // são autoritativos do servidor (o client não controla mais a posse).
      // O enum barra objetivo inventado, não o objetivo VÁLIDO e errado: com
      // `sem_historico` o derivado é `ativacao` por fato binário (não há venda),
      // e um "recuperacao" da IA venceria — plano de recuperação para cliente
      // que nunca comprou. Mesma reconciliação do edge (helper espelhado).
      const { objetivo: objetivoDoPlano, sobrescrito } = objetivoFinal(
        aiPlan?.strategic_objective,
        strategicObjective,
      );
      if (sobrescrito) {
        console.warn(
          `[useTacticalPlan] objetivo "${aiPlan?.strategic_objective}" da IA descartado: cliente ${customerId} é sem_historico (derivado: ativacao)`,
        );
      }

      const { error: rpcError } = await supabase.rpc('criar_plano_tatico' as never, {
        _customer_user_id: customerId,
        _expected_owner: ownerId,
        _payload: {
          bundle_recommendation_id: topBundle?.id || null,
          health_score: healthScore,
          churn_risk: churnRisk,
          mix_gap: mixGap,
          current_margin_pct: marginPct,
          cluster_avg_margin_pct: clusterMargin,
          expansion_potential: expansionPotential,
          strategic_objective: objetivoDoPlano,
          customer_profile: customerProfile,
          plan_type: planType,
          top_bundle: topBundle ? topBundle.bundle_products : {},
          second_bundle: secondBundle ? secondBundle.bundle_products : {},
          // [money-path "ausente ≠ zero"] Era `topBundle ? Number(topBundle.lie_bundle) : 0`
          // nos três + `best_individual_lie: 0`. Duas fabricações: sem bundle, e com bundle
          // de campo nulo (`Number(null) === 0`). O 0 persistia no banco e virava "Ganho
          // esperado R$ 0,00" na tela — afirmação que ninguém mediu. Helper espelhado na
          // edge (`plano-helpers.numerosDoBundle`), que é o OUTRO writer desta mesma tabela.
          ...numerosDoBundle(topBundle),
          diagnostic_questions: aiPlan?.diagnostic_questions || [],
          implication_question: aiPlan?.implication_question || '',
          offer_transition: aiPlan?.offer_transition || '',
          probable_objections: aiPlan?.probable_objections || [],
          approach_strategy: aiPlan?.approach_strategy || '',
          approach_strategy_b: aiPlan?.approach_strategy_b || '',
          ltv_projection: aiPlan?.ltv_projection || null,
          expected_result: aiPlan?.expected_result || null,
          operational_risks: aiPlan?.operational_risks || [],
        },
      } as never);
      if (rpcError) throw rpcError;

      toast.success(`Plano ${planType === 'estrategico' ? 'estratégico' : 'essencial'} gerado com sucesso`);
      await loadPlans();
    } catch (err) {
      console.error('Error generating plan:', err);
      // DUAS fronteiras onde a mensagem acionável morria, e as duas precisam estar de pé:
      //  1. a da EDGE — resolvida por `invokeFunction`, que lê o corpo de
      //     `FunctionsHttpError.context`; o `error.message` cru do supabase-js é sempre
      //     "Edge Function returned a non-2xx status code" e os 422 da edge ("Créditos da
      //     IA esgotados", "Plano cortado por tamanho") morreriam aí. Não trocar por
      //     `supabase.functions.invoke` cru.
      //  2. a do BANCO — `mensagemDeErro`: o `error` da RPC é um objeto PLANO (o
      //     supabase-js só instancia `PostgrestError` sob `.throwOnError()`), então o
      //     `err instanceof Error ? … : String(err)` de antes rendia **"[object Object]"**
      //     para TODA falha de `criar_plano_tatico`.
      const message = mensagemDeErro(err) ?? 'falha desconhecida';
      // A trava de idempotência não é falha: o plano de hoje já está na lista. Toast de
      // ERRO aqui mandaria a vendedora tentar de novo (ou acionar a equipe) por um
      // não-problema — e ela já pagou a espera da IA.
      if (ehJaGeradoHoje(message)) {
        toast.info('Já existe um plano gerado hoje para este cliente');
        await loadPlans();
        return;
      }
      toast.error('Erro ao gerar plano', { description: message });
    } finally {
      setGenerating(null);
    }
  }, [user, loadPlans]);

  // Get latest active plan for a customer (used by Copilot integration)
  const getActivePlan = useCallback(async (customerId: string): Promise<TacticalPlan | null> => {
    if (!effectiveUserId) return null;

    const owners = await fetchOwnerScope(effectiveUserId);
    const { data } = (await supabase
      .from('farmer_tactical_plans')
      .select('*')
      .in('farmer_id', owners)
      .eq('customer_user_id', customerId)
      .eq('status', 'gerado')
      .order('created_at', { ascending: false })
      .limit(1)) as unknown as { data: TacticalPlanRow[] | null };

    if (!data?.[0]) return null;

    const { data: profile } = (await supabase
      .from('profiles')
      .select('user_id, name')
      .eq('user_id', customerId)
      .single()) as unknown as { data: ProfileLite | null };

    const profileMap = new Map<string, string>([[customerId, profile?.name || 'Cliente']]);
    return parsePlan(data[0], profileMap);
  }, [effectiveUserId, fetchOwnerScope]);

  // Record post-call results
  // [money-path — ausente ≠ zero] Os três nullable são o tri-estado que o registro de 1 toque
  // produz: ele afirma só o desfecho. A RPC `registrar_resultado_plano` aceita NULL explícito
  // nos parâmetros (verificado por `pg_get_functiondef` na PROD, 2026-08-07 — o repo não é a
  // fonte, apply manual diverge) e as colunas de destino são todas nullable, sem CHECK.
  const recordResult = useCallback(async (planId: string, result: {
    planFollowed: boolean | null;
    callResult: string;
    actualMargin: number | null;
    callDurationSeconds: number | null;
    objectionType?: string;
    notes?: string;
  }) => {
    try {
      // Via RPC-fronteira (#1037 + split de RLS): gateia carteira_visivel_para(cliente do plano)
      // e a RLS pós-split nega UPDATE direto — fecha o #1 (qualquer staff com o UUID concluía
      // plano de carteira que não enxerga). completed_at/status são server-side.
      const { error } = await supabase.rpc('registrar_resultado_plano' as never, {
        _plan_id: planId,
        _plan_followed: result.planFollowed,
        _call_result: result.callResult,
        _actual_margin: result.actualMargin,
        _call_duration_seconds: result.callDurationSeconds,
        _objection_type: result.objectionType || null,
        _notes: result.notes || null,
      } as never);
      if (error) throw error;

      toast.success('Resultado registrado');
      await loadPlans();
    } catch (err) {
      console.error('Error recording result:', err);
      // Mesmo motivo do generatePlan: `registrar_resultado_plano` devolve o objeto plano do
      // PostgREST, e o `String(err)` de antes exibia "[object Object]" no lugar da recusa
      // real da RPC ("Plano fora da sua carteira", constraint, timeout).
      const message = mensagemDeErro(err) ?? 'falha desconhecida';
      // [SENSOR] O toast avisa a VENDEDORA e some. A falha ficava invisível para quem MEDE,
      // justo no passo que alimenta o dado escasso (`call_result`): um clique cuja RPC foi
      // recusada não deixa linha no banco e é indistinguível de "ela nem clicou". Cobre os
      // DOIS caminhos de registro — 1 toque e dialog detalhado — porque ambos passam por aqui.
      track('plano_tatico.desfecho_erro', {
        plano_id: planId,
        desfecho: result.callResult,
        mensagem: message,
      });
      toast.error('Erro ao registrar resultado', { description: message });
    }
  }, [loadPlans]);

  // Get effectiveness stats — efetividade da carteira PRÓPRIA por dono (effectiveUserId), NÃO inclui
  // coberturas (não inflar a métrica do gestor com a carteira do coberto; sob cobertura o plano
  // fica sob farmer_id=dono e conta pra efetividade do dono). Medir "por executor" exigiria uma
  // coluna generated_by — decisão adiada (YAGNI, 0 planos; ver docs/historico).
  const getEffectivenessStats = useCallback(async () => {
    if (!effectiveUserId) return null;

    const { data } = (await supabase
      .from('farmer_tactical_plans')
      .select('strategic_objective, plan_followed, actual_margin, call_duration_seconds, plan_type')
      .eq('farmer_id', effectiveUserId)
      .eq('status', 'concluido')) as unknown as { data: EffectivenessRow[] | null };

    if (!data?.length) return null;

    const byType: Record<string, AcumuladorEfetividade> = {};
    const byObjective: Record<string, AcumuladorEfetividade> = {};

    const acumular = (map: Record<string, AcumuladorEfetividade>, k: string, d: EffectivenessRow) => {
      if (!map[k]) {
        map[k] = { count: 0, followed: 0, comFollow: 0, totalMargin: 0, comMargem: 0, margemComTempo: 0, tempoComMargem: 0 };
      }
      const a = map[k];
      a.count++;
      // `!= null` e não truthy: `false` é declaração ("não segui o plano"), NULL é ausência.
      // O `if (d.plan_followed)` de antes fundia os dois no mesmo balde de "não seguiu".
      if (d.plan_followed != null) {
        a.comFollow++;
        if (d.plan_followed) a.followed++;
      }
      // `valorMedido` (e não `Number(x || 0)`) porque numeric do PostgREST chega como STRING:
      // preserva o 0 apurado e devolve null para ausência e para lixo não-finito.
      const margem = valorMedido(d.actual_margin);
      const tempo = valorMedido(d.call_duration_seconds);
      if (margem != null) {
        a.totalMargin += margem;
        a.comMargem++;
      }
      if (margem != null && tempo != null) {
        a.margemComTempo += margem;
        a.tempoComMargem += tempo;
      }
    };

    for (const d of data) {
      acumular(byObjective, d.strategic_objective, d);
      acumular(byType, d.plan_type || 'essencial', d);
    }

    // Tri-estado em TODAS as três métricas: `null` = não apurado nesta fatia, e quem exibir
    // decide como mostrar "sem dado" — nunca 0, que leria como "carteira sem margem" ou
    // "vendedora nunca segue o plano". `comFollow`/`comMargem` saem junto para que a tela
    // possa dizer sobre quantos planos a média foi calculada (amostra pequena é dado frágil).
    const mapStats = (map: Record<string, AcumuladorEfetividade>) =>
      Object.entries(map).map(([key, stats]) => ({
        key,
        label: objectiveLabels[key] || key,
        count: stats.count,
        comFollow: stats.comFollow,
        comMargem: stats.comMargem,
        followRate: stats.comFollow > 0 ? Math.round((stats.followed / stats.comFollow) * 100) : null,
        avgMargin: stats.comMargem > 0 ? stats.totalMargin / stats.comMargem : null,
        profitPerHour: stats.tempoComMargem > 0 ? (stats.margemComTempo / stats.tempoComMargem) * 3600 : null,
      }));

    return { byObjective: mapStats(byObjective), byType: mapStats(byType) };
  }, [effectiveUserId]);

  return {
    plans,
    loading,
    generating,
    totalNaFila,
    loadPlans,
    generatePlan,
    checkEfficiency,
    getActivePlan,
    recordResult,
    getEffectivenessStats,
  };
};
