// Edge Function: omie-sync-sku-items
// Popula sku_leadtime_history com 1 linha por item de NFe recebida (purchase_orders_tracking).
// Pública (verify_jwt = false).
//
// Body opcional:
//   { "empresa": "OBEN" | "COLACOR", "dias": 30, "fornecedor_codigo_omie": 8689681266 }
//
// Estratégia:
//   1) Lê NFes da empresa no período com t2_data_faturamento e nfe_chave_acesso.
//   2) Para cada NFe → ConsultarRecebimento(nIdReceb) → itera itensRecebimento[].
//   3) Para cada item, tenta achar o pedido específico via numero_contrato_fornecedor = nNumPedCompra.
//   4) UPSERT em sku_leadtime_history (tracking_id, sku_codigo_omie).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

interface OmieItemCabec {
  nIdProduto?: number | string;
  cCodigoProduto?: string;
  cDescricaoProduto?: string;
  cUnidadeNfe?: string;
  cNCM?: string;
  nQtdeNFe?: number | string;
  nPrecoUnit?: number | string;
  vTotalItem?: number | string;
}

interface OmieItemInfoAdic {
  nNumPedCompra?: number | string;
}

interface OmieItemAjustes {
  nQtdeRecebida?: number | string;
}

interface OmieRecebimentoItem {
  itensCabec?: OmieItemCabec;
  itensInfoAdic?: OmieItemInfoAdic;
  itensAjustes?: OmieItemAjustes;
}

interface OmieConsultarRecebimentoResponse {
  itensRecebimento?: OmieRecebimentoItem[];
  faultstring?: string;
  raw?: string;
}

interface NFeRawData {
  cabec?: { nIdReceb?: number | string };
}

interface PedidoTrackingMatchRow {
  id: string;
  t1_data_pedido: string;
  numero_pedido: string | null;
  grupo_leadtime: string | null;
  fornecedor_nome: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const RATE_LIMIT_DELAY_MS = 5000;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;
const TIMEOUT_GUARD_MS = 50_000;
const TIMEOUT_CHECK_EVERY_NFES = 5;

function redundantWaitMs(faultstring: string): number | null {
  const match = faultstring.match(/Aguarde\s+(\d+)\s+segundos/i);
  if (!match) return null;
  return (Number(match[1]) + 3) * 1000;
}

type Empresa = "OBEN" | "COLACOR";

interface RequestBody {
  empresa?: Empresa;
  dias?: number;
  fornecedor_codigo_omie?: number;
}

interface EmpresaSummary {
  empresa: Empresa;
  nfes_processadas: number;
  consultas_detalhadas: number;
  itens_processados: number;
  itens_com_pedido_mapeado: number;
  itens_sem_pedido: number;
  skus_distintos: number;
  erros: number;
  interrompido_por_timeout: boolean;
}

interface ExistingTrackingRow {
  tracking_id: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getCredentials(
  empresa: Empresa,
): { app_key: string; app_secret: string } {
  if (empresa === "OBEN") {
    const app_key = Deno.env.get("OMIE_OBEN_APP_KEY");
    const app_secret = Deno.env.get("OMIE_OBEN_APP_SECRET");
    if (!app_key || !app_secret) throw new Error("Credenciais OBEN ausentes");
    return { app_key, app_secret };
  }
  const app_key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const app_secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!app_key || !app_secret) throw new Error("Credenciais COLACOR ausentes");
  return { app_key, app_secret };
}

async function callOmie(
  app_key: string,
  app_secret: string,
  call: "ConsultarRecebimento",
  param: Record<string, unknown>,
): Promise<OmieConsultarRecebimentoResponse> {
  const body = { call, app_key, app_secret, param: [param] };
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    const res = await fetch(OMIE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: OmieConsultarRecebimentoResponse;
    try {
      json = JSON.parse(text) as OmieConsultarRecebimentoResponse;
    } catch {
      json = { raw: text };
    }
    const faultstring = typeof json?.faultstring === "string" ? json.faultstring : "";
    const waitMs = redundantWaitMs(faultstring) ?? RETRY_DELAY_MS;
    if (res.status === 429 || /rate limit|redundant|consumo redundante/i.test(faultstring)) {
      console.warn(
        `[sync-sku-items] ${call} aguardando ${Math.round(waitMs / 1000)}s por limite Omie (try ${attempt}/${MAX_RETRIES})`,
      );
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Omie ${call} HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return json;
  }
  throw new Error(`Omie ${call}: rate limit após ${MAX_RETRIES} tentativas`);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Dias úteis entre duas datas ISO (segunda..sexta). Convenção: lead time exclui o dia inicial. */
function diasUteisEntre(
  inicioIso: string | null,
  fimIso: string | null,
): number | null {
  if (!inicioIso || !fimIso) return null;
  const ini = new Date(inicioIso);
  const fim = new Date(fimIso);
  if (isNaN(ini.getTime()) || isNaN(fim.getTime()) || fim < ini) return null;
  let total = 0;
  const cursor = new Date(
    Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth(), ini.getUTCDate()),
  );
  const last = new Date(
    Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth(), fim.getUTCDate()),
  );
  while (cursor <= last) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) total++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(total - 1, 0);
}

interface NFeRow {
  id: string;
  nfe_chave_acesso: string;
  t1_data_pedido: string;
  t2_data_faturamento: string;
  t3_data_cte: string | null;
  t4_data_recebimento: string | null;
  fornecedor_codigo_omie: number;
  fornecedor_nome: string | null;
  raw_data: NFeRawData | null;
}

async function authorizeCronOrStaff(req: Request): Promise<boolean> {
  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SEC = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret && CRON_SEC && cronSecret === CRON_SEC) return true;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === SVC_KEY) return true;
  try {
    const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SVC_KEY } });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    if (!user?.id) return false;
    const roleRes = await fetch(`${SUPA_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, { headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` } });
    if (!roleRes.ok) return false;
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    return roles.some((r) => allowed.has(r.role));
  } catch { return false; }
}

// ─── Observabilidade em fin_sync_log (best-effort; NUNCA derruba o sync) ───
// Rastreabilidade independente do orquestrador: action LIKE 'sync_%' + companies em
// minúsculo (ex.: ['oben']) → o fin_sync_watchdog_check (*/30) JÁ reclassifica órfã
// 'running' (>30min) e alerta sync_error (≥2 falhas consecutivas) SEM mudar o watchdog.
// Como a edge completa em BACKGROUND além do abort de 25s do orquestrador, o completeSync
// roda no fim REAL (registra 'complete' de verdade); se a edge morrer antes (guard interno),
// a órfã 'running' é o sinal confiável de morte. Erro PARCIAL fica em results (NÃO vira
// status 'error' — evita alerta falso); só falha FATAL marca 'error'.
// empresa REAL sincronizada (espelha getCredentials: OBEN só se exatamente OBEN,
// senão COLACOR) → companies em minúsculo, sempre no conjunto que o watchdog varre
// (provado: o watchdog compara case-sensitive contra ['oben','colacor','colacor_sc']).
function empresaParaLog(e: string): string {
  return e.toUpperCase() === "OBEN" ? "oben" : "colacor";
}

async function logSync(
  db: SupabaseClient,
  action: string,
  companies: string[],
  triggeredBy: string,
): Promise<string> {
  try {
    // supabase-js NÃO lança em erro PostgREST — retorna { error }. Checar explícito,
    // senão um insert barrado por RLS/quota/schema some silencioso (logId vazio).
    const { data, error } = await db
      .from("fin_sync_log")
      .insert({ action, companies, status: "running", triggered_by: triggeredBy, started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) {
      console.error("[sync-sku-items] logSync erro PostgREST (segue sem log):", error.message);
      return "";
    }
    return (data as { id?: string } | null)?.id ?? "";
  } catch (e) {
    console.error("[sync-sku-items] logSync exceção (segue sem log):", e instanceof Error ? e.message : e);
    return "";
  }
}

async function completeSync(
  db: SupabaseClient,
  logId: string,
  results: Record<string, unknown>,
  errorMsg: string | undefined,
  duracaoMs: number,
): Promise<void> {
  if (!logId) return;
  try {
    const { error } = await db
      .from("fin_sync_log")
      .update({
        status: errorMsg ? "error" : "complete",
        results,
        error_message: errorMsg ?? null,
        duracao_ms: duracaoMs,
        completed_at: new Date().toISOString(),
      })
      .eq("id", logId);
    if (error) {
      // update que falha deixa a linha 'running' → vira órfã 'error' no watchdog.
      console.error("[sync-sku-items] completeSync erro PostgREST (linha fica 'running'):", error.message);
    }
  } catch (e) {
    console.error("[sync-sku-items] completeSync exceção (best-effort):", e instanceof Error ? e.message : e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  let logId = "";
  const triggeredBy = req.headers.get("x-cron-secret") ? "cron" : "manual";

  try {
    const body: RequestBody = await req.json().catch(() => ({}));
    const empresa: Empresa = (body.empresa ?? "OBEN") as Empresa;
    const dias = Math.max(1, Math.min(365, body.dias ?? 30));
    const fornecedorFiltro = body.fornecedor_codigo_omie ?? null;

    const { app_key, app_secret } = getCredentials(empresa);
    logId = await logSync(supabase, "sync_sku_items", [empresaParaLog(empresa)], triggeredBy);

    const cutoffIso = new Date(Date.now() - dias * 86_400_000).toISOString();

    let q = supabase
      .from("purchase_orders_tracking")
      .select(
        "id, nfe_chave_acesso, t1_data_pedido, t2_data_faturamento, t3_data_cte, t4_data_recebimento, fornecedor_codigo_omie, fornecedor_nome, raw_data",
      )
      .eq("empresa", empresa)
      .gte("t2_data_faturamento", cutoffIso)
      .not("t2_data_faturamento", "is", null)
      .not("nfe_chave_acesso", "is", null)
      .order("t2_data_faturamento", { ascending: false });
    if (fornecedorFiltro) q = q.eq("fornecedor_codigo_omie", fornecedorFiltro);

    const { data: nfes, error: nfesErr } = await q;
    if (nfesErr) throw nfesErr;

    const trackingIds = ((nfes ?? []) as NFeRow[]).map((nfe) => nfe.id);
    const existingTrackingIds = new Set<string>();
    if (trackingIds.length > 0) {
      const { data: existingRows, error: existingErr } = await supabase
        .from("sku_leadtime_history")
        .select("tracking_id")
        .in("tracking_id", trackingIds);
      if (existingErr) throw existingErr;
      for (const row of (existingRows ?? []) as ExistingTrackingRow[]) {
        if (row?.tracking_id) existingTrackingIds.add(row.tracking_id);
      }
    }

    const summary: EmpresaSummary = {
      empresa,
      nfes_processadas: 0,
      consultas_detalhadas: 0,
      itens_processados: 0,
      itens_com_pedido_mapeado: 0,
      itens_sem_pedido: 0,
      skus_distintos: 0,
      erros: 0,
      interrompido_por_timeout: false,
    };

    const skusVistos = new Set<number>();
    let nfesInspecionadas = 0;

    for (const nfeRaw of (nfes ?? []) as NFeRow[]) {
      nfesInspecionadas++;
      if (
        nfesInspecionadas % TIMEOUT_CHECK_EVERY_NFES === 0 &&
        Date.now() - startedAt > TIMEOUT_GUARD_MS
      ) {
        summary.interrompido_por_timeout = true;
        break;
      }

      if (existingTrackingIds.has(nfeRaw.id)) {
        continue;
      }

      summary.nfes_processadas++;

      const nIdReceb = nfeRaw.raw_data?.cabec?.nIdReceb;
      if (!nIdReceb) {
        console.warn(`[sync-sku-items] NFe ${nfeRaw.id} sem nIdReceb`);
        continue;
      }

      let detalhe: OmieConsultarRecebimentoResponse;
      try {
        await sleep(RATE_LIMIT_DELAY_MS);
        detalhe = await callOmie(app_key, app_secret, "ConsultarRecebimento", {
          nIdReceb: Number(nIdReceb),
        });
        summary.consultas_detalhadas++;
      } catch (e) {
        console.error(
          `[sync-sku-items] ConsultarRecebimento ${nIdReceb} falhou:`,
          e instanceof Error ? e.message : e,
        );
        continue;
      }

      const itens: OmieRecebimentoItem[] = Array.isArray(detalhe?.itensRecebimento)
        ? detalhe.itensRecebimento
        : [];

      for (const item of itens) {
        const cab = item?.itensCabec ?? {};
        const adic = item?.itensInfoAdic ?? {};
        const ajustes = item?.itensAjustes ?? {};

        const skuCodigoOmie = toNum(cab?.nIdProduto);
        if (!skuCodigoOmie) {
          continue;
        }

        const nNumPedCompra = toStr(adic?.nNumPedCompra);

        // Tentar mapear o pedido específico via numero_contrato_fornecedor
        let pedidoMatch: PedidoTrackingMatchRow | null = null;
        if (nNumPedCompra && nNumPedCompra !== "0") {
          const { data: pedidoRows, error: pedErr } = await supabase
            .from("purchase_orders_tracking")
            .select(
              "id, t1_data_pedido, numero_pedido, grupo_leadtime, fornecedor_nome",
            )
            .eq("empresa", empresa)
            .eq("fornecedor_codigo_omie", nfeRaw.fornecedor_codigo_omie)
            .eq("numero_contrato_fornecedor", nNumPedCompra)
            .limit(1);
          if (!pedErr && pedidoRows && pedidoRows.length > 0) {
            pedidoMatch = pedidoRows[0] as unknown as PedidoTrackingMatchRow;
          }
        }

        if (pedidoMatch) summary.itens_com_pedido_mapeado++;
        else summary.itens_sem_pedido++;

        const t1 = pedidoMatch?.t1_data_pedido ?? nfeRaw.t2_data_faturamento;
        const t2 = nfeRaw.t2_data_faturamento;
        const t3 = nfeRaw.t3_data_cte;
        const t4 = nfeRaw.t4_data_recebimento;

        const upsertRow = {
          tracking_id: nfeRaw.id,
          empresa,
          sku_codigo_omie: skuCodigoOmie,
          sku_codigo: toStr(cab?.cCodigoProduto),
          sku_descricao: toStr(cab?.cDescricaoProduto),
          sku_unidade: toStr(cab?.cUnidadeNfe),
          sku_ncm: toStr(cab?.cNCM),
          fornecedor_codigo_omie: nfeRaw.fornecedor_codigo_omie,
          fornecedor_nome: pedidoMatch?.fornecedor_nome ??
            nfeRaw.fornecedor_nome,
          grupo_leadtime: pedidoMatch?.grupo_leadtime ?? "OUTRO",
          quantidade_pedida: toNum(cab?.nQtdeNFe),
          quantidade_recebida: toNum(ajustes?.nQtdeRecebida),
          valor_unitario: toNum(cab?.nPrecoUnit),
          valor_total: toNum(cab?.vTotalItem),
          t1_data_pedido: t1,
          t2_data_faturamento: t2,
          t3_data_cte: t3,
          t4_data_recebimento: t4,
          lt_bruto_dias_uteis: diasUteisEntre(t1, t4),
          lt_faturamento_dias_uteis: diasUteisEntre(t1, t2),
          lt_logistica_dias_uteis: diasUteisEntre(t2, t4),
          updated_at: new Date().toISOString(),
        };

        const { error: upErr } = await supabase
          .from("sku_leadtime_history")
          .upsert(upsertRow, { onConflict: "tracking_id,sku_codigo_omie" });
        if (upErr) {
          summary.erros++;
          console.error(
            `[sync-sku-items] upsert NFe ${nfeRaw.id} sku ${skuCodigoOmie} falhou:`,
            upErr.message,
          );
          continue;
        }
        summary.itens_processados++;
        skusVistos.add(skuCodigoOmie);
      }

      if (Date.now() - startedAt > TIMEOUT_GUARD_MS) {
        summary.interrompido_por_timeout = true;
        break;
      }
    }

    summary.skus_distintos = skusVistos.size;
    // Rate-limit Omie total: havia NFes a processar mas NENHUMA consulta teve sucesso
    // → falha real (não "nada novo") → marca 'error'. Erro parcial fica em results.
    const falhaSistemica = summary.nfes_processadas > 0 && summary.consultas_detalhadas === 0
      ? `${summary.nfes_processadas} NFes mas 0 consultas Omie OK — rate-limit?`
      : undefined;
    await completeSync(supabase, logId, summary as unknown as Record<string, unknown>, falhaSistemica, Date.now() - startedAt);

    return new Response(
      JSON.stringify({
        ok: true,
        duracao_ms: Date.now() - startedAt,
        summary: [summary],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[sync-sku-items] erro fatal:", e);
    await completeSync(supabase, logId, {}, e instanceof Error ? e.message : String(e), Date.now() - startedAt);
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        duracao_ms: Date.now() - startedAt,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
