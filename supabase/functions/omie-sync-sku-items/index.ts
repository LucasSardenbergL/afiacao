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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const RATE_LIMIT_DELAY_MS = 1100;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;
const TIMEOUT_GUARD_MS = 90_000;
const TIMEOUT_CHECK_EVERY_NFES = 10;

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
): Promise<any> {
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
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (
      res.status === 429 ||
      (json?.faultstring && /rate limit/i.test(json.faultstring))
    ) {
      console.warn(
        `[sync-sku-items] ${call} rate limit (try ${attempt}/${MAX_RETRIES})`,
      );
      await sleep(RETRY_DELAY_MS);
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
  raw_data: any;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const startedAt = Date.now();

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body: RequestBody = await req.json().catch(() => ({}));
    const empresa: Empresa = (body.empresa ?? "OBEN") as Empresa;
    const dias = Math.max(1, Math.min(365, body.dias ?? 30));
    const fornecedorFiltro = body.fornecedor_codigo_omie ?? null;

    const { app_key, app_secret } = getCredentials(empresa);

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

      let detalhe: any;
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

      const itens: any[] = Array.isArray(detalhe?.itensRecebimento)
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
        let pedidoMatch: {
          id: string;
          t1_data_pedido: string;
          numero_pedido: string | null;
          grupo_leadtime: string | null;
          fornecedor_nome: string | null;
        } | null = null;
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
            pedidoMatch = pedidoRows[0] as any;
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
