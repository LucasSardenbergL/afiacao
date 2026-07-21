import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── Inline row/payload types (Edge Function bundles independent of @/integrations/supabase/types) ──
interface FarmerClientScoreRow {
  id: string;
  customer_user_id: string;
  farmer_id: string;
  health_score: number | null;
  health_class: string | null;
  churn_risk: number | null;
  priority_score: number | null;
  days_since_last_purchase: number | null;
  avg_monthly_spend_180d: number | null;
  category_count: number | null;
  gross_margin_pct: number | null;
  avg_repurchase_interval: number | null;
  expansion_score: number | null;
  recover_score: number | null;
  revenue_potential: number | null;
  rf_score: number | null;
  m_score: number | null;
  g_score: number | null;
  s_score: number | null;
  x_score: number | null;
  eff_score: number | null;
}

interface CustomerSalesSummaryRow {
  customer_user_id: string;
  days_since_last_purchase: number | null;  // calculado no SQL (data civil SP, COALESCE kpi null, clamp ≥0)
  total_revenue: number | null;             // all-time (válidos)
  revenue_180d: number | null;              // últimos 180d → avg_monthly_spend_180d = revenue_180d/6
  item_count: number | null;
  category_count: number | null;
}

interface FarmerClientScoreSeed {
  customer_user_id: string;
  farmer_id: string;
  health_score: number;
  health_class: string;
  churn_risk: number;
  priority_score: number;
  days_since_last_purchase: number;
  avg_monthly_spend_180d: number;
  category_count: number;
  gross_margin_pct: number;
  avg_repurchase_interval: number;
  expansion_score: number;
  recover_score: number;
  revenue_potential: number;
  rf_score: number;
  m_score: number;
  g_score: number;
  s_score: number;
  x_score: number;
  eff_score: number;
  sales_history_status: 'sem_historico' | 'stale' | 'ativo';
}

interface ScoreUpdate {
  id: string;
  // customer_user_id + farmer_id são NOT NULL em farmer_client_scores. O upsert
  // onConflict:'id' gera INSERT...ON CONFLICT, e o INSERT valida NOT NULL ANTES de
  // detectar o conflito → sem estas colunas o batch inteiro estoura (erro só logado,
  // não lançado) e nada persiste, mesmo a função retornando 200. Por isso o
  // calculated_at ficava congelado. (incidente 2026-05-27)
  customer_user_id: string;
  farmer_id: string;
  health_score: number;
  health_class: string;
  churn_risk: number;
  priority_score: number;
  rf_score: number;
  // m_score (componente de MARGEM) é nulável desde o PR 3-zero: null = margem desconhecida, e
  // apply_score_updates o tirou do guard de obrigatórias justamente por isso. NÃO trocar por 0.
  m_score: number | null;
  g_score: number;
  // MARGEM-VIVA: idem — null é "não medido", e a RPC grava direto (sem COALESCE) para que o
  // desconhecido sobrescreva um valor velho que já não se sustenta.
  gross_margin_pct: number | null;
  // RECÊNCIA-VIVA: o compute agora REESCREVE a base de vendas (antes só lia → congelava no seed).
  days_since_last_purchase: number;
  avg_monthly_spend_180d: number;
  category_count: number;
  // OPCIONAL na RPC (COALESCE, fora do guard das 13): null quando salesRefreshFatal → preserva o atual.
  sales_history_status: 'sem_historico' | 'stale' | 'ativo' | null;
  calculated_at: string;
  updated_at: string;
}

interface HealthHistoryRecord {
  customer_user_id: string;
  farmer_id: string;
  health_score: number;
  health_class: string;
  rf_score: number;
  m_score: number | null;   // null = margem desconhecida neste run (PR 3-zero); nunca 0 por default
  g_score: number;
  x_score: number;
  s_score: number;
  churn_risk: number;
}

interface PriorityLogRecord {
  customer_user_id: string;
  farmer_id: string;
  priority_score: number;
  margin_potential_component: number;
  churn_risk_component: number;
  repurchase_component: number;
  goal_proximity_component: number;
}

// Margem-viva (PR 3-zero): contraparte de CustomerSalesSummaryRow para get_customer_margin_summary.
// `gross_margin_pct` NULL = custo DESCONHECIDO (nenhum item do cliente tem linha em product_costs
// com custo > 0), NÃO margem zero.
interface CustomerMarginSummaryRow {
  customer_user_id: string;
  itens_com_custo: number;
  itens_sem_custo: number;
  gross_margin_pct: number | null;
}

// Margem conhecida? Só número finito conta. null/undefined/NaN → desconhecida, e quem chama TEM de
// excluir o componente do score em vez de tratar como 0 — margem 0 é veredito ("cliente ruim"),
// desconhecida é ausência de dado. Espelha custoValido() de src/lib/custo/custoCanonico.ts.
function margemConhecida(pct: number | null | undefined): number | null {
  if (pct == null) return null;
  const n = Number(pct);
  return Number.isFinite(n) ? n : null;
}

// Recência-viva: espelho inline de src/lib/scoring/salesBase.ts (vitest 8/8; Deno não importa de
// src/). Degradação honesta: ausente → 999/0/0 ("ausente ≠ zero"); Number.isFinite guarda NaN.
function deriveSalesBase(sales: CustomerSalesSummaryRow | null | undefined): {
  days_since_last_purchase: number; avg_monthly_spend_180d: number; category_count: number;
} {
  const daysRaw = sales ? Number(sales.days_since_last_purchase ?? 999) : 999;
  const days = Number.isFinite(daysRaw) ? daysRaw : 999;
  const revenue180 = Number(sales?.revenue_180d ?? 0);
  const spend = Number.isFinite(revenue180) ? Math.round(revenue180 / 6) : 0;
  const catRaw = Number(sales?.category_count ?? 0);
  const category = Number.isFinite(catRaw) ? catRaw : 0;
  return { days_since_last_purchase: days, avg_monthly_spend_180d: spend, category_count: category };
}

// Recência (cap linear) — espelho inline de src/lib/scoring/recency.ts (vitest 13/13 + falsificação;
// Deno não importa de src/). Substitui a normalização ÷maxDaysSince, que comprimia (90d→96) e dava ~55
// ao sentinela 999 (o max real era venda REAL de ~2235d, não o sentinela). Guardrail [30,999]: T>999
// ressuscitaria o sentinela. Money-path: days ausente/null/NaN → recência 0 (NUNCA 100). Paridade:
// mudou aqui → mude lá.
const DEFAULT_CAP_DAYS = 180;
const MIN_CAP_DAYS = 30;
const MAX_CAP_DAYS = 999;
function clampRecencyCapDays(raw: unknown): number {
  if (raw == null) return DEFAULT_CAP_DAYS; // null/undefined → default (Number(null)===0 fabricaria 30)
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CAP_DAYS;
  return Math.min(MAX_CAP_DAYS, Math.max(MIN_CAP_DAYS, Math.round(n)));
}

function computeRecencyScore(daysSinceLastPurchase: number | null | undefined, capDays: number): number {
  const cap = clampRecencyCapDays(capDays); // re-clampa (idempotente; nunca 0 → sem div/0)
  const days = (daysSinceLastPurchase != null && Number.isFinite(daysSinceLastPurchase))
    ? Math.max(0, daysSinceLastPurchase)
    : cap; // null/undefined/NaN/Infinity → "no teto" → recência 0 (ausente ≠ comprou-hoje)
  return Math.max(0, 100 - (Math.min(days, cap) / cap) * 100);
}

// sales_history_status — espelho inline de src/lib/scoring/salesHistoryStatus.ts (vitest 10/10 +
// falsificação; Deno não importa de src/). Money-path: "ausente ≠ zero" no OUTPUT. sem_historico =
// sem venda válida monetizada no resumo. clampActiveDays é PRÓPRIO (sales_active_threshold_days ≠
// hs_recency_cap_days — semânticas distintas, desacopladas de propósito). Paridade: mudou aqui → mude lá.
function clampActiveDays(raw: number | null | undefined): number {
  if (raw == null) return 180; // Number(null)===0 é finito → guard ANTES do clamp
  const n = Number(raw);
  if (!Number.isFinite(n)) return 180;
  return Math.min(999, Math.max(30, Math.round(n)));
}
function deriveSalesHistoryStatus(
  sales: CustomerSalesSummaryRow | null | undefined,
  activeThresholdDays: number,
): 'sem_historico' | 'stale' | 'ativo' {
  const cap = clampActiveDays(activeThresholdDays);
  const revenue = sales ? Number(sales.total_revenue ?? 0) : 0;
  if (!Number.isFinite(revenue) || revenue <= 0) return 'sem_historico';
  const daysRaw = sales ? sales.days_since_last_purchase : null;
  const days = Number(daysRaw);
  if (daysRaw == null || !Number.isFinite(days)) return 'stale';
  return days <= cap ? 'ativo' : 'stale';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    // ANTI-DRIFT (carteira-Omie Opção A): farmer_id do score = carteira_assignments.owner_user_id.
    // NUNCA seedar/atribuir score por atividade (farmer_calls/route_visits).

    // ── Service client for privileged operations ──
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Load configurable weights
    const { data: configRows } = await supabase
      .from('farmer_algorithm_config')
      .select('key, value');

    const config: Record<string, number> = {};
    configRows?.forEach(r => { config[r.key] = Number(r.value); });

    // Health Score weights (defaults matching the spec)
    const hs_w = {
      recency: (config['hs_weight_recency'] ?? 25) / 100,
      frequency: (config['hs_weight_frequency'] ?? 20) / 100,
      margin: (config['hs_weight_margin'] ?? 20) / 100,
      diversity: (config['hs_weight_diversity'] ?? 15) / 100,
      crosssell: (config['hs_weight_crosssell'] ?? 10) / 100,
      engagement: (config['hs_weight_engagement'] ?? 10) / 100,
    };

    // Priority Score weights
    const ps_w = {
      margin_potential: (config['ps_weight_margin_potential'] ?? 35) / 100,
      churn_risk: (config['ps_weight_churn_risk'] ?? 30) / 100,
      repurchase: (config['ps_weight_repurchase'] ?? 20) / 100,
      goal_proximity: (config['ps_weight_goal_proximity'] ?? 15) / 100,
    };

    // Recência: teto (dias até zerar) configurável, guardrail [30,999] (achado /codex: T>999
    // ressuscitaria o sentinela 999). Default 180. Ajustável sem redeploy via farmer_algorithm_config.
    const recencyCapDays = clampRecencyCapDays(config['hs_recency_cap_days']);

    // sales_history_status: limiar (dias) ativo vs stale — config próprio, desacoplado do cap de recência.
    const salesActiveDays = config['sales_active_threshold_days'] ?? 180;

    // Get all client scores with pagination
    let clients: FarmerClientScoreRow[] = [];
    {
      let pg = 0;
      const sz = 1000;
      let more = true;
      while (more) {
        const { data: batch, error: bErr } = await supabase
          .from('farmer_client_scores')
          .select('*')
          .range(pg * sz, (pg + 1) * sz - 1);
        if (bErr) throw bErr;
        if (!batch || batch.length === 0) { more = false; }
        else {
          clients.push(...(batch as unknown as FarmerClientScoreRow[]));
          if (batch.length < sz) more = false;
          pg++;
        }
      }
    }

    // === RECÊNCIA-VIVA: snapshot de vendas (RPC) carregado TODO run ===
    // É a FONTE do refresh de recência/gasto/diversidade de TODA linha (antes só rodava no seed).
    // `salesRefreshFatal` é flag SOFT run-wide: RPC falha → a recência fica CONGELADA este run
    // (degrada honesto, NÃO starva o compute) e é surfaceada (500) DEPOIS do compute. supabase-js
    // NÃO lança em erro de RPC → checar `error`.
    let salesRefreshFatal: Error | null = null;
    const salesMap = new Map<string, CustomerSalesSummaryRow>();
    try {
      const { data, error } = await supabase.rpc('get_customer_sales_summary');
      if (error) {
        salesRefreshFatal = new Error(`get_customer_sales_summary retornou erro — recência congelada este run: ${error.message}`);
        console.error('[calculate-scores]', salesRefreshFatal.message);
      } else {
        for (const s of (data ?? []) as unknown as CustomerSalesSummaryRow[]) salesMap.set(s.customer_user_id, s);
      }
    } catch (e) {
      // supabase-js normalmente RETORNA {error}, mas rejeição de fetch/rede LANÇA — capturar aqui
      // também (senão o try/catch EXTERNO daria 500 ANTES do compute, quebrando o contrato
      // "RPC falha → degrada pra congelado, compute roda" — achado Codex).
      salesRefreshFatal = e instanceof Error ? e : new Error(String(e));
      console.error('[calculate-scores] get_customer_sales_summary lançou — recência congelada este run:', salesRefreshFatal.message);
    }

    // === MARGEM-VIVA (PR 3-zero): a margem do health score, calculada no SERVIDOR ===
    // ANTES desta chamada a margem NUNCA era computada: esta função lia client.gross_margin_pct da
    // PRÓPRIA farmer_client_scores que ela escreve (loop fechado sobre o 0 do seed) — medido em prod
    // 2026-07-20: 1.214 de 1.214 clientes COM pedido tinham gross_margin_pct = 0, nenhum não-zero.
    // A RPC é SECURITY DEFINER com EXECUTE só p/ service_role: o custo é lido aqui, no servidor, e
    // só a margem AGREGADA por cliente atravessa — o custo unitário nunca sai do banco.
    // Mesma degradação da recência-viva: RPC falha → SEM overlay → margem fica no valor anterior
    // (stale-mas-não-pior), nunca zerada por acidente.
    let marginRefreshFatal: Error | null = null;
    const marginMap = new Map<string, CustomerMarginSummaryRow>();
    try {
      const { data, error } = await supabase.rpc('get_customer_margin_summary');
      if (error) {
        marginRefreshFatal = new Error(`get_customer_margin_summary retornou erro — margem congelada este run: ${error.message}`);
        console.error('[calculate-scores]', marginRefreshFatal.message);
      } else {
        for (const m of (data ?? []) as unknown as CustomerMarginSummaryRow[]) marginMap.set(m.customer_user_id, m);
      }
    } catch (e) {
      // supabase-js RETORNA {error} no caso normal, mas rejeição de fetch/rede LANÇA — mesmo motivo
      // do catch da RPC de vendas: sem isto o try/catch externo daria 500 ANTES do compute.
      marginRefreshFatal = e instanceof Error ? e : new Error(String(e));
      console.error('[calculate-scores] get_customer_margin_summary lançou — margem congelada este run:', marginRefreshFatal.message);
    }

    // === AUTO-SEED v2 (F1 — reset-path robusto): completa clientes FALTANTES ===
    // Antes só rodava com a tabela VAZIA (gate length===0) — frágil: 1 linha esparsa do
    // scoring-recalc-client (agora UPDATE-only) ou qualquer reset parcial suprimia o seed.
    // Agora: detecta FALTANTES via RPC ATÔMICA (seed_targets_faltantes: omie − fcs − flaggeds num
    // só snapshot) e só carrega ownerMap QUANDO há o que semear. (A RPC de vendas roda TODO run —
    // recência-viva, acima — e o seed reusa o salesMap do topo.)
    // seedErrors é coletado aqui mas LANÇADO depois do COMPUTE (não starvar o recompute dos
    // existentes por 1 linha-veneno no seed — achado Codex). Espelha src/lib/scoring/seedTargets.ts.
    const seedErrors: string[] = [];
    let seedFatal: Error | null = null;
    // O seed/descoberta roda em TRY: QUALQUER falha (RPC seed_targets/ownerMap/insert) é
    // CAPTURADA e adiada — o COMPUTE dos existentes NUNCA é starvado por falha de seed
    // (achado Codex). A falha é surfaceada DEPOIS do compute, ou no empty-guard (fail-closed).
    try {
      // FALTANTES filtrados ATOMICAMENTE no banco via RPC seed_targets_faltantes (migration
      // 20260621120000): omie_clientes − farmer_client_scores − flaggeds num ÚNICO snapshot.
      // Substitui as 3 leituras PostgREST SEPARADAS + filtro em memória (computeSeedTargets), cuja
      // inconsistência ENTRE snapshots (flaggeds vindo vazio/incompleto — quirk do .eq, lag de
      // réplica) fazia `missing = missingRaw` e RESSUSCITAVA os fornecedores excluídos no seed
      // (FAIL-OPEN, exposto pelo smoke 2026-06-20: semeou os 509 flagged). A RPC lê as 3 tabelas no
      // MESMO snapshot e só retorna quem é SEGURO semear (fail-closed por construção). FAIL-CLOSED:
      // erro → lança (não semeia às cegas; idempotente, o próximo run converge). Paginada com .range
      // (ORDER BY user_id estável na RPC — §5 do CLAUDE.md). Espelha src/lib/scoring/seedTargets.ts.
      const missing: Array<{ user_id: string }> = [];
      for (let sp = 0; ; sp++) {
        const { data: sPage, error: sErr } = await supabase
          .rpc('seed_targets_faltantes')
          .range(sp * 1000, sp * 1000 + 999);
        if (sErr) throw new Error(`seed_targets_faltantes falhou — não dá p/ semear sem a lista atômica de elegíveis: ${sErr.message}`);
        const sRows = (sPage ?? []) as Array<{ user_id: string }>;
        for (const r of sRows) missing.push(r);
        if (sRows.length < 1000) break;
      }

      if (missing.length === 0) {
        console.log(`[calculate-scores] 0 faltantes a semear (${clients.length} em fcs). Pula seed.`);
      } else {
        if (salesRefreshFatal) {
          // RPC de vendas falhou → NÃO semear os faltantes (deriveSalesBase daria 999/0 p/ TODOS =
          // fabricar zero; #936 "ausente≠zero"). Entram quando a RPC voltar (idempotente).
          console.warn(`[calculate-scores] RPC de vendas falhou — pulando seed de ${missing.length} faltantes este run.`);
        } else {
          console.log(`[calculate-scores] semeando ${missing.length} faltantes (${clients.length} já em fcs).`);

          // Farmer default (1º employee/master) — fallback do ownerMap.
          const { data: employees } = await supabase
            .from('user_roles')
            .select('user_id')
            .in('role', ['master', 'employee']);
          const defaultFarmerId = employees?.[0]?.user_id || '414a9727-ad1d-4998-914e-9c6ccf26cf50';

          // Opção A (carteira-Omie): dono do score = dono da carteira. FAIL-CLOSED: erro de
          // leitura → lança (ownerMap truncado semearia farmer_id errado = dono errado na
          // agenda — achado Codex #3). ANTI-DRIFT: score nunca deriva de atividade.
          const ownerMap = new Map<string, string>();
          for (let cp = 0; ; cp++) {
            const { data: aPage, error: aErr } = await supabase
              .from('carteira_assignments')
              .select('customer_user_id, owner_user_id')
              .range(cp * 1000, cp * 1000 + 999);
            if (aErr) throw new Error(`carteira_assignments falhou ao semear: ${aErr.message}`);
            const aRows = (aPage ?? []) as Array<{ customer_user_id: string; owner_user_id: string }>;
            for (const r of aRows) ownerMap.set(r.customer_user_id, r.owner_user_id);
            if (aRows.length < 1000) break;
          }

          // Registros de seed só dos FALTANTES, da base de vendas (salesMap do TOPO) via
          // deriveSalesBase — mesma degradação honesta do compute (vitest 8/8). Aqui já é garantido
          // que !salesRefreshFatal (o ramo acima pula o seed se a RPC falhou).
          const seedRecords: FarmerClientScoreSeed[] = [];
          for (const client of missing) {
            const base = deriveSalesBase(salesMap.get(client.user_id));
            seedRecords.push({
              customer_user_id: client.user_id,
              farmer_id: ownerMap.get(client.user_id) ?? defaultFarmerId,
              health_score: 0,
              health_class: 'novo',
              churn_risk: 0,
              priority_score: 0,
              days_since_last_purchase: base.days_since_last_purchase,
              avg_monthly_spend_180d: base.avg_monthly_spend_180d,
              category_count: base.category_count,
              gross_margin_pct: 0,
              avg_repurchase_interval: 0,
              expansion_score: 0,
              recover_score: 0,
              revenue_potential: 0,
              rf_score: 0,
              m_score: 0,
              g_score: 0,
              s_score: 0,
              x_score: 0,
              eff_score: 0,
              sales_history_status: deriveSalesHistoryStatus(salesMap.get(client.user_id), salesActiveDays),
            });
          }

          // Insere em lotes de 200. F2: coleta os erros (LANÇADOS depois do COMPUTE — não
          // starvar o recompute dos existentes por 1 linha-veneno; achado Codex #5). O
          // fallback one-by-one REGISTRA a falha (antes engolia o singleErr).
          let seeded = 0;
          for (let i = 0; i < seedRecords.length; i += 200) {
            const batch = seedRecords.slice(i, i + 200);
            const { data: inserted, error: insertErr } = await supabase
              .from('farmer_client_scores')
              .upsert(batch, { onConflict: 'customer_user_id' })
              .select('id');
            if (insertErr) {
              console.error(`[calculate-scores] Batch insert error at ${i}:`, insertErr.message);
              for (const record of batch) {
                const { data: one, error: singleErr } = await supabase
                  .from('farmer_client_scores')
                  .upsert(record, { onConflict: 'customer_user_id' })
                  .select('id');
                if (singleErr) seedErrors.push(`${record.customer_user_id}: ${singleErr.message}`);
                else seeded += (one?.length ?? 0);
              }
            } else {
              // Conta as linhas REALMENTE persistidas: o trigger fcs_block_flagged_insert pula o
              // fornecedor flagged (RETURN NULL) → ele não volta no .select('id') → o log não infla
              // "Seeded N" mascarando quantos foram bloqueados mid-run (achado /codex P2 2026-06-21).
              seeded += (inserted?.length ?? 0);
            }
          }
          console.log(`[calculate-scores] Seeded ${seeded}/${missing.length} client scores`);

          // Re-fetch p/ incluir os recém-semeados no compute. Em LOCAL: se a leitura falhar
          // (throw → catch do seed), clients mantém o snapshot original (não clobbera o compute).
          const refetched: FarmerClientScoreRow[] = [];
          {
            let pg2 = 0;
            const sz2 = 1000;
            let more2 = true;
            while (more2) {
              const { data: batch2, error: rErr2 } = await supabase
                .from('farmer_client_scores')
                .select('*')
                .range(pg2 * sz2, (pg2 + 1) * sz2 - 1);
              if (rErr2) throw rErr2;
              if (!batch2 || batch2.length === 0) { more2 = false; }
              else {
                refetched.push(...(batch2 as unknown as FarmerClientScoreRow[]));
                if (batch2.length < sz2) more2 = false;
                pg2++;
              }
            }
          }
          clients = refetched;
        }
      }
    } catch (e) {
      // Seed/descoberta falhou. NÃO starvar o compute dos existentes — captura e adia.
      seedFatal = e instanceof Error ? e : new Error(String(e));
      console.error('[calculate-scores] seed/descoberta falhou (adiado p/ depois do compute):', seedFatal.message);
    }

    // Guard: sem nenhuma linha a computar. FAIL-CLOSED: se o seed FALHOU numa fcs vazia (fatal
    // de descoberta OU per-row), NÃO retorna 200 — lança (senão um reset totalmente falho passaria
    // como "Sem clientes" silencioso — achado Codex). Com linhas existentes, segue p/ o compute.
    if (!clients || clients.length === 0) {
      if (seedFatal) throw seedFatal;
      if (salesRefreshFatal) throw salesRefreshFatal;
      if (seedErrors.length > 0) {
        throw new Error(`seed falhou em ${seedErrors.length} cliente(s) numa fcs vazia: ${seedErrors.slice(0, 3).join(' | ')}`);
      }
      return new Response(JSON.stringify({
        message: 'Sem clientes para pontuar (rode o sync de clientes).',
        seeded: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === RECÊNCIA-VIVA: overlay dos valores FRESCOS (salesMap) nos clients em memória ANTES do compute ===
    // Assim os maxes (maxSpend/maxCategories) E o loop (recência via cap) leem fresco — e o ScoreUpdate
    // persiste days/spend/category (que NUNCA eram reescritos → recência congelava no dia do seed).
    // RPC falhou (salesRefreshFatal) → NÃO faz overlay → compute roda nos days CONGELADOS (degrada
    // honesto, stale-mas-não-pior; a falha é surfaceada depois do compute). Cobre existentes E
    // recém-semeados (re-fetchados acima). Só toca os 3 campos da RPC; os demais base ficam.
    if (!salesRefreshFatal) {
      for (const c of clients) {
        const b = deriveSalesBase(salesMap.get(c.customer_user_id));
        c.days_since_last_purchase = b.days_since_last_purchase;
        c.avg_monthly_spend_180d = b.avg_monthly_spend_180d;
        c.category_count = b.category_count;
      }
    }

    // Overlay da MARGEM — separado do de vendas de propósito: são duas RPCs independentes e uma pode
    // falhar sem a outra; acoplá-las congelaria a margem por causa de um erro de recência (e vice-versa).
    // Cliente ausente do marginMap (sem pedido, ou só com item sem custo) → NULL, jamais 0.
    if (!marginRefreshFatal) {
      for (const c of clients) {
        c.gross_margin_pct = margemConhecida(marginMap.get(c.customer_user_id)?.gross_margin_pct);
      }
    }

    // Compute normalization ranges (recência NÃO usa min-max — cap configurável via computeRecencyScore)
    const maxInterval = Math.max(...clients.map(c => Number(c.avg_repurchase_interval || 0)), 1);
    const maxSpend = Math.max(...clients.map(c => Number(c.avg_monthly_spend_180d || 0)), 1);
    // Só margens CONHECIDAS entram no max: `|| 0` faria o desconhecido participar da normalização
    // como se fosse margem zero, deprimindo o teto e inflando o score relativo de todo mundo.
    const maxMarginPct = Math.max(...clients.map(c => margemConhecida(c.gross_margin_pct) ?? 0), 1);
    const maxCategories = Math.max(...clients.map(c => Number(c.category_count || 0)), 1);
    const maxRevPotential = Math.max(...clients.map(c => Number(c.revenue_potential || 0)), 1);

    const healthHistoryRecords: HealthHistoryRecord[] = [];
    const priorityLogRecords: PriorityLogRecord[] = [];
    const updates: ScoreUpdate[] = [];

    for (const client of clients) {
      // --- Health Score ---
      // Recência: cap linear (computeRecencyScore), NÃO ÷maxDaysSince. Passa o days CRU (helper trata
      // null→recência 0, sem o `|| 0` que fabricaria 100). rf_score=0 empata 180/999/2235 → "quão morto"
      // se lê de days_since_last_purchase, não de rf_score (achado /codex).
      const recencyScore = computeRecencyScore(client.days_since_last_purchase, recencyCapDays);
      
      const freqScore = maxInterval > 0
        ? Math.max(0, 100 - (Number(client.avg_repurchase_interval || maxInterval) / maxInterval) * 100)
        : 50;
      
      // Margem DESCONHECIDA → null, e o componente sai do score (renormalização abaixo). Com o
      // `|| 0` anterior, "não medi" virava veredito "margem zero" = pior cliente possível naquele
      // eixo — fabricação de número no money-path. Margem negativa é dado real: pontua 0 (piso),
      // não negativo, senão um único cliente no prejuízo arrastaria o health para baixo do zero.
      const margemPct = margemConhecida(client.gross_margin_pct);
      const marginScore = margemPct == null
        ? null
        : Math.max(0, Math.min(100, (margemPct / maxMarginPct) * 100));

      const diversityScore = maxCategories > 0
        ? Math.min(100, (Number(client.category_count || 0) / maxCategories) * 100)
        : 0;
      
      const crossSellScore = Number(client.x_score || 0);
      const engagementScore = Number(client.s_score || 0);

      // Renormalização: sem margem conhecida, o peso dela é redistribuído entre os componentes que
      // existem, em vez de contribuir 0. Os hs_w somam 1,0 (cada um é config/100), então com margem
      // conhecida pesoTotal=1 e a divisão é identidade — o score de quem TEM margem não muda.
      const pesoMargem = marginScore == null ? 0 : hs_w.margin;
      const pesoTotal = hs_w.recency + hs_w.frequency + pesoMargem
                      + hs_w.diversity + hs_w.crosssell + hs_w.engagement;
      const somaPonderada =
        recencyScore * hs_w.recency +
        freqScore * hs_w.frequency +
        (marginScore ?? 0) * pesoMargem +
        diversityScore * hs_w.diversity +
        crossSellScore * hs_w.crosssell +
        engagementScore * hs_w.engagement;
      const healthScore = Math.round(pesoTotal > 0 ? somaPonderada / pesoTotal : 0);

      let healthClass = 'critico';
      if (healthScore >= 75) healthClass = 'saudavel';
      else if (healthScore >= 50) healthClass = 'estavel';
      else if (healthScore >= 25) healthClass = 'atencao';

      const churnRisk = Math.max(0, Math.min(100, 100 - healthScore));

      // --- Priority Score ---
      const marginPotentialComp = maxRevPotential > 0
        ? (Number(client.revenue_potential || 0) / maxRevPotential) * 100
        : 0;
      
      const churnComp = churnRisk;
      
      const daysSince = Number(client.days_since_last_purchase || 0);
      const avgInterval = Number(client.avg_repurchase_interval || 30);
      const repurchaseComp = avgInterval > 0
        ? Math.max(0, Math.min(100, (1 - Math.abs(daysSince - avgInterval) / avgInterval) * 100))
        : 50;
      
      const goalComp = maxSpend > 0
        ? Math.min(100, (Number(client.avg_monthly_spend_180d || 0) / maxSpend) * 100)
        : 0;

      const priorityScore = Math.round(
        marginPotentialComp * ps_w.margin_potential +
        churnComp * ps_w.churn_risk +
        repurchaseComp * ps_w.repurchase +
        goalComp * ps_w.goal_proximity
      );

      updates.push({
        id: client.id,
        // customer_user_id/farmer_id: enviados por compat (ScoreUpdate), mas apply_score_updates
        // os IGNORA — UPDATE-only por id (ver bloco de persist). Mantidos p/ não mexer no shape.
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        health_score: healthScore,
        health_class: healthClass,
        churn_risk: churnRisk,
        priority_score: priorityScore,
        rf_score: Math.round(recencyScore),
        // Math.round(null) é 0 — o arredondamento fabricaria justamente o número que este PR
        // remove. O null tem de atravessar até a coluna.
        m_score: marginScore == null ? null : Math.round(marginScore),
        g_score: Math.round(diversityScore),
        // MARGEM-VIVA: persiste a margem calculada no servidor (pós-overlay). Sem esta linha o
        // cálculo novo morreria em memória e a coluna seguiria no 0 do seed.
        gross_margin_pct: margemPct,
        // RECÊNCIA-VIVA: persiste a base de vendas FRESCA (pós-overlay) — antes congelava no seed.
        days_since_last_purchase: client.days_since_last_purchase ?? 999,
        avg_monthly_spend_180d: client.avg_monthly_spend_180d ?? 0,
        category_count: client.category_count ?? 0,
        // salesRefreshFatal → null → a RPC (COALESCE) preserva o valor atual (não fabrica por RPC ausente).
        sales_history_status: salesRefreshFatal ? null : deriveSalesHistoryStatus(salesMap.get(client.customer_user_id), salesActiveDays),
        calculated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      healthHistoryRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        health_score: healthScore,
        health_class: healthClass,
        rf_score: Math.round(recencyScore),
        m_score: marginScore == null ? null : Math.round(marginScore),  // idem: null ≠ 0
        g_score: Math.round(diversityScore),
        x_score: Math.round(crossSellScore),
        s_score: Math.round(engagementScore),
        churn_risk: churnRisk,
      });

      priorityLogRecords.push({
        customer_user_id: client.customer_user_id,
        farmer_id: client.farmer_id,
        priority_score: priorityScore,
        margin_potential_component: Math.round(marginPotentialComp),
        churn_risk_component: Math.round(churnComp),
        repurchase_component: Math.round(repurchaseComp),
        goal_proximity_component: Math.round(goalComp),
      });
    }

    // Batch update scores via RPC apply_score_updates — UPDATE-only, anti-ressurreição (fecha o chip).
    // Se aplicar_exclusao_fornecedores() (migration 20260606170100) DELETAR uma linha mid-run, o `id`
    // stale NÃO casa (WHERE f.id=u.id → 0 linhas): a RPC NÃO re-insere (mata a ressurreição) e jamais
    // tenta INSERT → nunca 23505. (O upsert(onConflict:'id') anterior ressuscitava/colidia.) Provado em
    // PG17 + falsificação: db/test-apply-score-updates.sh. O payload ainda traz customer_user_id/farmer_id
    // (ScoreUpdate), que a RPC IGNORA (recordset = id + 12 campos: os 9 de score + 3 de base de vendas
    // [days/spend/category, persistidos desde a migration 20260622140000]; customer_user_id/farmer_id NÃO
    // entram) — inofensivo.
    // F2 (FAIL-CLOSED) mantido: erro de RPC coleta-e-LANÇA (recompute parcial não pode passar como 200 OK;
    // idempotente → retry converge; visível em net._http_response). Chunk de 500 = 1 statement/batch,
    // limita payload/blast-radius (Codex P2). NÃO lança em affected<enviados: é o sinal ESPERADO de linha
    // excluída mid-run (a RPC corretamente não a ressuscita) → loga como drift, não 500 (Codex P2).
    console.log(`[calculate-scores] Updating ${updates.length} client scores via apply_score_updates...`);
    const updateErrors: string[] = [];
    let scoresAffected = 0;
    for (let i = 0; i < updates.length; i += 500) {
      const batch = updates.slice(i, i + 500);
      const { data: affected, error: uErr } = await supabase.rpc('apply_score_updates', { p_updates: batch });
      if (uErr) { console.error(`[calculate-scores] Batch RPC error at ${i}:`, uErr.message); updateErrors.push(`@${i}: ${uErr.message}`); }
      else { scoresAffected += Number(affected ?? 0); }
    }
    if (updateErrors.length > 0) {
      throw new Error(`recompute falhou em ${updateErrors.length} batch(es): ${updateErrors.slice(0, 3).join(' | ')}`);
    }
    if (scoresAffected < updates.length) {
      console.log(`[calculate-scores] apply_score_updates afetou ${scoresAffected}/${updates.length} linhas — diferença = fornecedor(es) excluído(s) mid-run pelo cleanup (esperado, NÃO ressuscitado).`);
    }

    // F2 (achados Codex #5 + reorder): o COMPUTE dos existentes já persistiu (NÃO foi starvado
    // por falha de descoberta nem por 1 linha-veneno no seed). Agora surface a falha — 200 OK
    // não pode mascarar seed/descoberta falho. Idempotente: o próximo run recomputa a diferença
    // e completa o resto. Antes do history p/ não duplicar a série temporal em run persistente.
    if (seedFatal) throw seedFatal;
    // RECÊNCIA-VIVA: RPC falhou → o compute rodou nos days CONGELADOS (degradou, não starvou) e os
    // 3 campos foram reescritos com o valor antigo (no-op). Surface 500 (idempotente: o próximo run
    // com a RPC OK refresca a recência). Antes do history.
    if (salesRefreshFatal) throw salesRefreshFatal;
    if (seedErrors.length > 0) {
      throw new Error(`seed falhou em ${seedErrors.length} cliente(s): ${seedErrors.slice(0, 3).join(' | ')}${seedErrors.length > 3 ? ` (+${seedErrors.length - 3})` : ''}`);
    }

    // Insert history in batches of 500. FORA da fronteira fail-closed: history/priority-log são
    // audit append-only (time-series), NÃO estado money-path (a fonte é farmer_client_scores).
    // Se um insert falhar, LOGA warning e segue — não vira 500 (evitaria retry duplicando a série).
    // [auditoria 2026-06-18, follow-up Codex/#954] Estes records vêm do SNAPSHOT lido no início do
    // run — NÃO filtrados pelos ids que sobreviveram ao UPDATE — então uma linha de fornecedor
    // excluído mid-run (cron aplicar_exclusao_fornecedores) pode vazar p/ a série. TOLERADO de
    // propósito: a varredura (frontend src/ + pg_proc/pg_views/pg_matviews em PROD + crons) não
    // achou NENHUM leitor money-path destas tabelas — são série-temporal de display/tendência. SE
    // algum dia surgir um leitor que decida algo FIRME (priorização/comissão/agenda) lendo daqui
    // direto: filtrar estes inserts pelos ids efetivamente atualizados (ex.: a RPC update-only
    // anti-ressurreição retornar os ids afetados) ou re-checar excluir_da_carteira. Precisão > recall.
    for (let i = 0; i < healthHistoryRecords.length; i += 500) {
      const { error: hErr } = await supabase.from('health_score_history').insert(healthHistoryRecords.slice(i, i + 500));
      if (hErr) console.warn(`[calculate-scores] health_score_history insert warn @${i}: ${hErr.message}`);
    }
    for (let i = 0; i < priorityLogRecords.length; i += 500) {
      const { error: pErr } = await supabase.from('priority_score_log').insert(priorityLogRecords.slice(i, i + 500));
      if (pErr) console.warn(`[calculate-scores] priority_score_log insert warn @${i}: ${pErr.message}`);
    }

    return new Response(JSON.stringify({
      message: `Scores calculated for ${updates.length} clients`,
      weights: { health: hs_w, priority: ps_w },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Score calculation error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
