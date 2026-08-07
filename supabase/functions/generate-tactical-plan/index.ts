// Edge Function: generate-tactical-plan
//
// Migrada do gateway Lovable/Gemini (LOVABLE_API_KEY + google/gemini-3-flash-preview)
// para a Anthropic direta — fase 3 de 4 (fase 1: #1592, fase 2: #1608). O gateway tem
// teto próprio de créditos ("AI features usage limit", 4/mês); ao estourar em 2026-07-27
// ele derrubou as 7 edges que serve, e o batch noturno de planos táticos — o maior
// consumidor, 59 chamadas/dia — parou por completo (0 planos de 27/07 a 29/07).
// Contrato de request/response inalterado: o front (useTacticalPlan) não muda.
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
// ⚠️ usar npm: (não esm.sh) — esm.sh/@supabase/supabase-js falhava em resolver no boot
// do edge runtime, dando RUNTIME_ERROR sem linha/stack (lição do #1592).
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { avaliarCanariaMargem, calcularClusterMargin, classifyProfile, margemConhecida, selectObjective } from "../_shared/tactical-margem.ts";
import { inicioDiaOperacional } from "../_shared/dia-operacional.ts";
import {
  ehJaGeradoHojeDaRpc,
  ehSkipLegitimoDaRpc,
  extrairToolUseUnico,
  MAX_TOKENS,
  MODELO,
  type Modo,
  montarPlano,
  numerosDoBundle,
  numeroValido,
  objetivoFinal,
  objetivoValido,
  statusDeErroIa,
  systemDoModo,
  toolDoModo,
} from "./plano-helpers.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Teto de recência (dias até a recência zerar), lido de farmer_algorithm_config.hs_recency_cap_days.
// Default 180, guardrail [30,999]. Ausente/null/NaN → default (Number(null)===0 fabricaria a fronteira
// mínima 30). Espelho VERBATIM da clampRecencyCapDays de src/lib/scoring/objective.ts e
// supabase/functions/calculate-scores/index.ts (Deno não importa de src/) — mudou aqui, mude lá.
const DEFAULT_RECENCY_CAP_DAYS = 180;
const MIN_RECENCY_CAP_DAYS = 30;
const MAX_RECENCY_CAP_DAYS = 999;
function clampRecencyCapDays(raw: unknown): number {
  if (raw == null) return DEFAULT_RECENCY_CAP_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RECENCY_CAP_DAYS;
  return Math.min(MAX_RECENCY_CAP_DAYS, Math.max(MIN_RECENCY_CAP_DAYS, Math.round(n)));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

  try {
    const body = await req.json();

    // CANÁRIA COMPORTAMENTAL do helper de margem (#1498) — NÃO escreve, NÃO chama LLM, NÃO toca o
    // DB. Roda as decisões PURAS de `_shared/tactical-margem.ts` DEPLOYADAS (não as da `main`)
    // sobre fixtures fixos e compara com o esperado.
    //
    // POR QUE ELA EXISTE: em 2026-07-22 gastamos uma sessão inteira tentando provar que o #1498
    // estava no ar e NÃO conseguimos. O dado de produção não discrimina os dois códigos: o gate de
    // R$/h ≥ 50 filtra estruturalmente quem não tem margem (velho: NULL→`?? 0`→R$0/h→reprovado;
    // novo: indecidível→excluído), então o batch produz o MESMO conjunto nos dois. O cron das 08:00
    // gerou 2 planos de 3.858 clientes, todos limpos — consistente com a correção estar no ar E com
    // ela não estar. Sem probe, a única via era o founder gerar um plano à mão para um cliente sem
    // margem. Isto substitui esse clique.
    //
    // Prova duas coisas que o commit de deploy NÃO prova: (1) esta action RESPONDE ⇒ o helper subiu
    // no MESMO build (senão o body cai no fluxo normal e falta `customerContext`); (2) a lógica
    // certa está no ar — margem ausente degrada em vez de fabricar. NÃO prova que o real-path usa o
    // helper (isso é o guard textual + paridade), prova que a DECISÃO deployada está correta. Os
    // fixtures vivem no helper (`avaliarCanariaMargem`), testados em tactical-margem_test.ts.
    if (body.canary === true) {
      const { ok, resultados } = avaliarCanariaMargem();
      return new Response(JSON.stringify({ canary: true, ok, resultados }), {
        status: ok ? 200 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // CANÁRIA DE VERSÃO (docs/agent/deploy.md, padrão do #1590/#1592): no Lovable Cloud não
    // há PAT, então o deploy de edge não tem prova de VERSÃO — só "foi servida". Este probe
    // é a prova, e custa zero (não chama o modelo, não toca o DB):
    //   curl -s -X POST <url> -H 'content-type: application/json' \
    //        -H "x-cron-secret: <secret>" -d '{"probe":true}'
    //   → {"motor":"anthropic",...}  = fase 3 no ar
    //   → {"error":"AI não configurada"} ou plano gerado = ainda a versão do gateway Lovable
    if (body.probe === true) {
      return new Response(
        JSON.stringify({
          ok: true,
          motor: 'anthropic',
          modelo: MODELO,
          tool: toolDoModo('estrategico').name,
          fallback_fabricado: false,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Modo self-contained (cron): body traz { customerId, farmerId } e a edge monta o
    // contexto + grava o plano. Modo front (legado): body traz customerContext já montado
    // e o front é quem grava (useTacticalPlan.generatePlan).
    const selfContained = Boolean(body.customerId && body.farmerId);

    // [Codex #1] o modo self-contained GRAVA via service_role (que pula o gate de carteira da
    // criar_plano_tatico). Só cron/service_role pode acioná-lo — senão um staff, com
    // {customerId, farmerId} arbitrários, geraria plano numa carteira que NÃO enxerga.
    // Staff usa o modo front (não-selfContained), onde o front grava via RPC COM o gate.
    if (selfContained && __auth.via === 'staff') {
      return new Response(JSON.stringify({ error: 'Forbidden: modo self-contained é cron-only' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Modo front (legado): exige Bearer-user. Modo self-contained já foi autenticado por
    // authorizeCronOrStaff (via x-cron-secret) lá em cima — não precisa do user token.
    if (!selfContained) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    const mode = body.planType || 'essencial';

    // No modo front estas chegam prontas no body; no self-contained são montadas abaixo.
    let customerContext = body.customerContext;
    let bundleContext = body.bundleContext;
    let diagnosticData = body.diagnosticData;
    let historicalObjections = body.historicalObjections;
    let topBundleRow: Record<string, unknown> | null = null;
    let secondBundleRow: Record<string, unknown> | null = null;

    if (selfContained) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const { customerId, farmerId } = body;

      // Idempotência: pula se já há plano 'gerado' no DIA OPERACIONAL (BRT), não no dia UTC.
      // Era `>= 00:00 UTC` e errava nos DOIS sentidos (incidente 2026-07-21/22, 30 duplicatas):
      // run às 22:48 BRT não via o das 19:03 do mesmo dia; e o cron das 05:00 BRT do dia
      // seguinte via o da véspera e pulava o dia inteiro. Ver _shared/dia-operacional.ts.
      const hojeIso = inicioDiaOperacional(new Date());
      const { data: existente } = await admin.from('farmer_tactical_plans')
        .select('id').eq('farmer_id', farmerId).eq('customer_user_id', customerId)
        .eq('status', 'gerado').gte('created_at', hojeIso).limit(1);
      if (existente?.length) {
        return new Response(JSON.stringify({ id: existente[0].id, skipped: 'ja_gerado_hoje' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Pares da carteira do dono para o cluster de margem. TRÊS correções vs. a versão
      // anterior (`select('gross_margin_pct').eq('farmer_id', farmerId)`), espelhando
      // useTacticalPlan.ts:404-418:
      //  1. PAGINA (fetchAll): sem .range() o PostgREST capa em 1.000 SILENCIOSO e os 3
      //     farmers em prod têm até 3.858 clientes — a régua saía de uma amostra arbitrária
      //     de ~26% da carteira, sem sequer um .order() que a tornasse estável (#1471).
      //  2. EXCLUI o próprio cliente (peer benchmark): comparar a margem do cliente com um
      //     cluster que o contém puxa a régua na direção do próprio valor.
      //  3. Falha de leitura → [] → cluster null (degradação honesta: o plano sai sem a
      //     régua de margem, em vez de sair com uma régua truncada).
      const peersClusterPromise = fetchAll<{ gross_margin_pct: number | null }>(
        (from, to) => admin
          .from('farmer_client_scores')
          .select('gross_margin_pct')
          .eq('farmer_id', farmerId)
          .neq('customer_user_id', customerId)
          .order('customer_user_id', { ascending: true }) // UNIQUE ⇒ estável entre páginas
          .range(from, to),
        'pares da carteira p/ cluster de margem',
      ).catch(() => [] as Array<{ gross_margin_pct: number | null }>);

      const [{ data: score }, { data: profile }, { data: bundles }, peersCluster, { data: objEvents }, { data: recencyCapRow }] = await Promise.all([
        // Opção A: 1 linha por cliente (customer_user_id único). NÃO filtrar por farmer_id —
        // score stale pós-reatribuição (dono ≠ farmerId) virava "sem_score" falso e PULAVA o
        // plano do cliente reatribuído. Espelha useTacticalPlan.checkEfficiency (admin = service role).
        admin.from('farmer_client_scores').select('*').eq('customer_user_id', customerId).maybeSingle(),
        admin.from('profiles').select('name, customer_type, cnae').eq('user_id', customerId).maybeSingle(),
        admin.from('farmer_bundle_recommendations').select('*').eq('customer_user_id', customerId).eq('farmer_id', farmerId).eq('status', 'pendente').order('lie_bundle', { ascending: false }).limit(2),
        peersClusterPromise, // paginada acima; entra no mesmo Promise.all p/ não serializar
        admin.from('farmer_copilot_events').select('event_data').eq('event_type', 'suggestion').limit(20),
        // Teto de recência (hs_recency_cap_days): a fronteira reativacao/recuperacao ACOMPANHA o teto
        // do modelo, não o 90 hardcode. Ausente → clampRecencyCapDays default 180. limit(1) p/ maybeSingle
        // não lançar em chave duplicada. Espelha useTacticalPlan.ts:341 (caminho front) + calculate-scores.
        admin.from('farmer_algorithm_config').select('value').eq('key', 'hs_recency_cap_days').limit(1).maybeSingle(),
      ]);
      if (!score) {
        return new Response(JSON.stringify({ skipped: 'sem_score' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // `num` só sobrevive nos campos cuja ausência NÃO chega aqui: health_score, churn_risk,
      // avg_monthly_spend_180d, category_count e days_since_last_purchase têm 0 nulos em prod
      // (medido via psql-ro em 2026-07-29, 6.633 linhas) e alimentam decisão DETERMINÍSTICA —
      // classifyProfile/selectObjective/mixGap. Nulá-los seria pior que inerte: `null < 500` é
      // `true` em JS, então "não medido" viraria o rótulo `sensivel_preco` e `8 - null` daria
      // mixGap 8 (money-path.md §2, corolário JS). Só se troca `?? 0` por null onde a ausência
      // REALMENTE chega — e onde o consumidor sabe tratá-la.
      const num = (v: unknown) => Number(v ?? 0);
      const healthScore = num(score.health_score), churnRisk = num(score.churn_risk), avgSpend = num(score.avg_monthly_spend_180d);
      const categoryCount = num(score.category_count), daysSince = num(score.days_since_last_purchase);
      // [money-path "ausente ≠ zero"] expansion_score e revenue_potential são as DUAS colunas
      // que a 20260727130000_farmer_scores_colunas_orfas_null nulou de propósito (nenhum writer
      // as calcula) — e a migration está APLICADA: 6.633/6.633 NULL, `column_default` removido
      // (psql-ro, 2026-07-29). Com `num()` elas chegavam ao prompt como `0` para 100% da base, e
      // o system prompt manda a IA ler número como MEDIDO — "revenuePotential: 0" afirma
      // "cliente sem potencial" sobre um cliente que ninguém mediu, e é a partir disso que a
      // vendedora decide a abordagem. `numeroValido` devolve o null honesto que a instrução
      // DADO AUSENTE (plano-helpers.ts) já sabe interpretar. Nenhum dos dois entra em
      // comparação relacional aqui — só no prompt e no payload (colunas nullable).
      const expansionPotential = numeroValido(score.expansion_score);
      const revenuePotential = numeroValido(score.revenue_potential);
      // money-path "ausente ≠ zero": margem desconhecida fica `null` e é EXCLUÍDA dos
      // cálculos — nunca 0 (que afirmaria "cliente sem margem") nem a média fabricada.
      const marginPct = margemConhecida(score.gross_margin_pct);
      const salesHistoryStatus = (score.sales_history_status ?? null) as string | null;
      // Sem par com margem conhecida → null. Era `: 25` — um número inventado que virava
      // a régua de `marginPct < cluster * 0.8` e empurrava consolidacao_margem a esmo,
      // plausível o bastante para não levantar suspeita. Mesma correção que o front já
      // aplicou em objective.ts; o edge era o lado que faltava.
      const clusterMargin = calcularClusterMargin(peersCluster);
      const mixGap = Math.max(0, 8 - categoryCount);

      // classifyProfile/selectObjective — _shared/tactical-margem.ts, espelho TESTADO de
      // useTacticalPlan.ts + objective.ts (antes eram encadeamentos inline não-testados).
      // Fronteira reativacao/recuperacao = daysSince >= teto de recência (ponto onde o sinal de
      // recência satura em 0), NÃO o 90 mágico — espelha selectObjective (objective.ts) pós-#982.
      // recencyCapDays vem do config (acompanha o retuning do operador).
      // sem_historico → ativacao PRECEDE tudo (#1026): sem venda válida, nada p/ recuperar/reativar.
      // Margem (do cliente ou do cluster) ausente → a regra de consolidacao_margem NÃO dispara:
      // o guard null que o front já tinha e que este lado não tinha, porque o fallback 25
      // garantia um número — fabricado.
      const customerProfile = classifyProfile(healthScore, avgSpend, marginPct, categoryCount);
      const recencyCapDays = clampRecencyCapDays(recencyCapRow?.value);
      const strategicObjective = selectObjective(
        churnRisk, mixGap, marginPct, clusterMargin, daysSince, recencyCapDays, salesHistoryStatus,
      );

      topBundleRow = bundles?.[0] ?? null;
      secondBundleRow = bundles?.[1] ?? null;
      historicalObjections = (objEvents ?? [])
        .map((e: { event_data: { intent?: unknown } | null }) => (e.event_data as { intent?: unknown } | null)?.intent)
        .filter((i: unknown): i is string => typeof i === 'string' && i.startsWith('objecao')).slice(0, 5);

      customerContext = { name: profile?.name, cnae: profile?.cnae, customerType: profile?.customer_type, profile: customerProfile, healthScore, churnRisk, avgMonthlySpend: avgSpend, grossMarginPct: marginPct, categoryCount, daysSinceLastPurchase: daysSince, mixGap, clusterAvgMargin: clusterMargin, expansionPotential, revenuePotential, salesHistoryStatus };
      bundleContext = topBundleRow ? { products: topBundleRow.bundle_products, lie: topBundleRow.lie_bundle, probability: topBundleRow.p_bundle, margin: topBundleRow.m_bundle } : null;
      diagnosticData = { strategicObjective };
      // Paridade com o front: no modo estratégico, inclui o 2º bundle p/ comparação.
      if (mode === 'estrategico' && secondBundleRow) {
        (diagnosticData as Record<string, unknown>).secondBundle = { products: secondBundleRow.bundle_products, lie: secondBundleRow.lie_bundle, probability: secondBundleRow.p_bundle, margin: secondBundleRow.m_bundle };
      }
      (body as Record<string, unknown>)._derived = { healthScore, churnRisk, mixGap, marginPct, clusterMargin, expansionPotential, customerProfile, strategicObjective };
    }

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'AI não configurada' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Os prompts e os schemas de tool vivem em plano-helpers.ts (puro ⇒ testável sob
    // --no-remote). Antes eram dois templates inline pedindo "retorne APENAS o JSON,
    // sem markdown" — o forced tool-use torna o contrato estrutural em vez de textual,
    // e com ele some a classe inteira de "resposta não parseou".
    const modo: Modo = mode === 'estrategico' ? 'estrategico' : 'essencial';
    const tool = toolDoModo(modo);

    const userPrompt = `Dados do cliente:
${JSON.stringify(customerContext || {}, null, 2)}

Bundle prioritário:
${JSON.stringify(bundleContext || {}, null, 2)}

Dados diagnósticos:
${JSON.stringify(diagnosticData || {}, null, 2)}

Objeções históricas do cluster:
${JSON.stringify(historicalObjections || [], null, 2)}`;

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let resposta;
    try {
      resposta = await anthropic.messages.create({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        // prompt caching no system: ele é o prefixo ESTÁVEL entre os 59 alvos do batch
        // noturno (o contexto do cliente, que varia, vem na mensagem do usuário).
        system: [{ type: 'text', text: systemDoModo(modo), cache_control: { type: 'ephemeral' } }],
        tools: [tool],
        // `type:'tool'` sozinho NÃO desliga chamada paralela: o modelo poderia emitir um
        // bloco por seção e o consumo pegaria só o primeiro, gravando um plano PARCIAL
        // com cara de completo (P1 do /codex no #1608).
        tool_choice: { type: 'tool', name: tool.name, disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: userPrompt }],
      });
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      const detalhe = e instanceof Error ? e.message : String(e);
      console.error('[generate-tactical-plan] erro na API da Anthropic:', status, detalhe);
      // O 402 NÃO desapareceu com o gateway: a Anthropic devolve billing_error. Sem
      // mapeá-lo, a MESMA falha que motivou esta migração voltaria como 500 genérico e o
      // batch registraria http_500 sem dizer que o problema é saldo.
      const mapeado = statusDeErroIa(status);
      if (mapeado) {
        return new Response(JSON.stringify({ error: mapeado.msg }), {
          status: mapeado.http,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error('Erro ao processar com IA');
    }

    // §8 money-path: teto que trunca fabrica completude. Um plano cortado no meio chega
    // à vendedora indistinguível de um plano inteiro — não grava.
    if (resposta.stop_reason === 'max_tokens') {
      console.error(`[generate-tactical-plan] resposta truncada em ${MAX_TOKENS} tokens`);
      return new Response(
        JSON.stringify({ error: `Plano cortado por tamanho (${MAX_TOKENS} tokens) — não gravado.` }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const extraido = extrairToolUseUnico(resposta.content);
    if (!extraido.ok) {
      console.error(
        `[generate-tactical-plan] tool_use ${extraido.motivo} (${extraido.quantidade} blocos): ${extraido.texto}`,
      );
      return new Response(
        JSON.stringify({ error: 'A IA não devolveu um plano utilizável.' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Âncora do objetivo: `selectObjective` já decidiu por regra determinística sobre os
    // scores. É o único campo com fallback legítimo — não é chute, é o valor do servidor.
    const objetivoServidor = String(
      (diagnosticData as { strategicObjective?: unknown } | null)?.strategicObjective ?? 'expansao_mix',
    );
    const montagem = montarPlano(extraido.input, modo, objetivoServidor);

    // ANTES (P2 aberto desde 2026-07-04, revisao-completa-2026-07-04.md:71): quando o
    // JSON.parse da resposta em texto livre falhava, a edge montava um plano genérico
    // — "Abordagem consultiva padrão" + 3 perguntas fixas sobre ritmo de produção — e o
    // GRAVAVA via criar_plano_tatico com status 'gerado', indistinguível de um plano real.
    // Falhar alto é barato; um roteiro que ninguém escreveu para aquele cliente, não.
    if (!montagem.ok) {
      console.error(`[generate-tactical-plan] plano vazio: ${montagem.detalhe}`);
      return new Response(
        JSON.stringify({ error: 'A IA não devolveu um plano utilizável.', detalhe: montagem.detalhe }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    for (const aviso of montagem.avisos) {
      console.warn(`[generate-tactical-plan] ${aviso}`);
    }

    const plan = { ...montagem.plano, plan_type: modo };

    // Modo self-contained (cron): grava o plano via RPC-fronteira criar_plano_tatico.
    // A posse (farmer_id) é re-resolvida server-side de carteira_assignments — não confiamos
    // no body.farmerId resolvido no início do batch (pode estar stale se a carteira foi
    // reatribuída durante a geração da IA). _expected_owner=body.farmerId faz a RPC ABORTAR no
    // race em vez de gravar dono stale (precisão>recall). farmer_id/customer/status são do servidor.
    if (selfContained) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      // marginPct/clusterMargin/expansionPotential podem ser null (dado não medido). As colunas
      // current_margin_pct/cluster_avg_margin_pct/expansion_potential são nullable (conferido em
      // prod via psql-ro) — o plano grava "não sei" em vez de um número, e a UI mostra "—" em vez
      // de um potencial inventado. Gravar o 0 fabricado seria pior que exibi-lo: ele PERSISTE e
      // vira histórico com cara de medição.
      const d = (body as { _derived: Record<string, number | string | null> })._derived;

      // O enum barra objetivo inventado, não o objetivo VÁLIDO e errado. Com
      // `sem_historico` o servidor derivou `ativacao` de um fato binário (não há
      // venda válida); um "recuperacao" vindo do modelo passaria no enum e
      // venceria, gravando plano de recuperação para quem nunca comprou.
      const { objetivo: objetivoDoPlano, sobrescrito } = objetivoFinal(
        objetivoValido(plan.strategic_objective),
        typeof d.strategicObjective === 'string' ? d.strategicObjective : null,
      );
      if (sobrescrito) {
        console.warn(
          `[generate-tactical-plan] objetivo "${plan.strategic_objective}" do modelo descartado: cliente ${body.customerId} é sem_historico (servidor: ativacao)`,
        );
      }

      const { data: newId, error: rpcErr } = await admin.rpc('criar_plano_tatico', {
        _customer_user_id: body.customerId,
        _expected_owner: body.farmerId,
        _payload: {
          bundle_recommendation_id: (topBundleRow as { id?: string } | null)?.id ?? null,
          health_score: d.healthScore, churn_risk: d.churnRisk, mix_gap: d.mixGap,
          current_margin_pct: d.marginPct, cluster_avg_margin_pct: d.clusterMargin, expansion_potential: d.expansionPotential,
          strategic_objective: objetivoDoPlano, customer_profile: d.customerProfile, plan_type: mode,
          top_bundle: (topBundleRow ? topBundleRow.bundle_products : {}),
          second_bundle: (secondBundleRow ? (secondBundleRow as { bundle_products: unknown }).bundle_products : {}),
          // [money-path "ausente ≠ zero"] Era `Number(topBundleRow?.x ?? 0)` nos três + um
          // `best_individual_lie: 0` hardcoded. Sem bundle (o caso de 339/339 planos em prod,
          // medido 2026-07-31) a vendedora recebia "LIE R$ 0,00" e "Probabilidade 0,0%" como
          // MEDIÇÃO — a afirmação "não vale a pena vender este bundle", que ninguém fez. As
          // quatro colunas são nullable e a RPC insere o valor EXPLÍCITO (o `DEFAULT 0` da
          // tabela não intercepta), então o null chega ao banco de verdade. Ver numerosDoBundle.
          ...numerosDoBundle(topBundleRow),
          diagnostic_questions: plan.diagnostic_questions ?? [], implication_question: plan.implication_question ?? '',
          offer_transition: plan.offer_transition ?? '', probable_objections: plan.probable_objections ?? [],
          approach_strategy: plan.approach_strategy ?? '', approach_strategy_b: plan.approach_strategy_b ?? '',
          ltv_projection: plan.ltv_projection ?? null, expected_result: plan.expected_result ?? null,
          operational_risks: plan.operational_risks ?? [],
        },
      });
      if (rpcErr) {
        console.error('criar_plano_tatico falhou', body.customerId, rpcErr.message);
        // A TRAVA DE IDEMPOTÊNCIA PEGOU. O `ja_gerado_hoje` do começo do handler é um
        // check-then-insert: dois batches simultâneos consultam antes de qualquer insert,
        // ambos pagam a chamada à Anthropic e ambos inserem (o `FOR UPDATE` da RPC trava a
        // carteira, mas ela não repetia o teste de existência e não havia índice único).
        // Agora a RPC recusa DEPOIS do lock — a duplicata deixa de existir, e o custo da IA
        // já gasto vira um skip honesto em vez de um http_500 que o lote contaria como erro.
        // Motivo PRÓPRIO (não `rpc_race`): o relatório precisa distinguir "a trava funcionou"
        // de "a carteira mudou no meio da geração".
        if (ehJaGeradoHojeDaRpc(rpcErr.message)) {
          return new Response(JSON.stringify({ skipped: 'ja_gerado_hoje', detail: rpcErr.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Race de reatribuição / cliente sem dono / cliente mascarado → SKIP legítimo: o
        // próximo ciclo re-lista farmer_client_scores já reconciliado e gera sob o dono
        // certo. Não derruba o batch.
        if (ehSkipLegitimoDaRpc(rpcErr.message)) {
          return new Response(JSON.stringify({ skipped: 'rpc_race', detail: rpcErr.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Qualquer OUTRA falha (timeout, cast, constraint, indisponibilidade) é ERRO. Antes
        // tudo virava `skipped:'rpc_error'`, e o batch conta skip como "pulado" com
        // `ok: erros === 0` — um lote sem NENHUM plano gravado reportava ok:true, a mesma
        // classe do incidente de 2026-07-21 (money-path: falha silenciosa).
        return new Response(JSON.stringify({ error: 'Falha ao gravar o plano', detail: rpcErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: newId, generated: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify(plan),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in generate-tactical-plan:', error);
    return new Response(
      JSON.stringify({ error: 'Erro ao gerar plano tático' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
