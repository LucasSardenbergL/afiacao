// Edge Function: omie-sync-pedidos-compra
// Sincroniza pedidos de compra do Omie (Oben + Colacor) para a tabela purchase_orders_tracking
// Pública (verify_jwt = false) - acionada via POST manual ou cron

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ===== Constantes =====
const SAYERLACK = {
  CNPJ: "61142865000691",
  OBEN_codigo_cliente_omie: 8689681266,
  COLACOR_codigo_cliente_omie: 393820664,
};

const OMIE_ENDPOINT_PEDIDOS =
  "https://app.omie.com.br/api/v1/produtos/pedidocompra/";

const PAGE_SIZE = 50;
const RATE_LIMIT_DELAY_MS = 1100;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

type Empresa = "OBEN" | "COLACOR";

interface RequestBody {
  empresa?: "OBEN" | "COLACOR" | "ALL";
  dias?: number;
  fornecedor_codigo_omie?: number;
}

interface EmpresaSummary {
  empresa: Empresa;
  total_paginas: number;
  pedidos_sincronizados: number;
  erros: number;
}

// ===== Helpers =====
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatDateBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseBRDateToISO(dateBR?: string | null, timeBR?: string | null): string | null {
  if (!dateBR) return null;
  const m = dateBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const time = timeBR && /^\d{2}:\d{2}(:\d{2})?$/.test(timeBR)
    ? (timeBR.length === 5 ? `${timeBR}:00` : timeBR)
    : "00:00:00";
  // Trata como horário Brasil (UTC-3) e converte pra UTC ISO
  return `${yyyy}-${mm}-${dd}T${time}-03:00`;
}

function parseBRDateOnly(dateBR?: string | null): string | null {
  if (!dateBR) return null;
  const m = dateBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function getCredentials(empresa: Empresa): { app_key: string; app_secret: string } {
  if (empresa === "OBEN") {
    const app_key = Deno.env.get("OMIE_OBEN_APP_KEY");
    const app_secret = Deno.env.get("OMIE_OBEN_APP_SECRET");
    if (!app_key || !app_secret) {
      throw new Error("Credenciais OBEN ausentes: OMIE_OBEN_APP_KEY e/ou OMIE_OBEN_APP_SECRET");
    }
    return { app_key, app_secret };
  }
  const app_key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const app_secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!app_key || !app_secret) {
    throw new Error("Credenciais COLACOR ausentes: OMIE_COLACOR_APP_KEY e/ou OMIE_COLACOR_APP_SECRET");
  }
  return { app_key, app_secret };
}

async function callOmie(
  app_key: string,
  app_secret: string,
  pagina: number,
  dataDe: string,
  dataAte: string,
  fornecedorCodigo?: number,
): Promise<any> {
  const param: Record<string, unknown> = {
    pagina,
    registros_por_pagina: PAGE_SIZE,
    apenas_importado_api: "N",
    filtrar_por_data_de: dataDe,
    filtrar_por_data_ate: dataAte,
  };
  if (fornecedorCodigo) {
    // Campo correto na ListarPedidosCompra é "filtrar_por_codigo" para fornecedor
    param.filtrar_por_codigo = fornecedorCodigo;
  }

  const body = {
    call: "ListarPedidosCompra",
    app_key,
    app_secret,
    param: [param],
  };

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    const res = await fetch(OMIE_ENDPOINT_PEDIDOS, {
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

    // Rate limit
    if (res.status === 429 || (json?.faultstring && /rate limit/i.test(json.faultstring))) {
      console.warn(`[omie] rate limit atingido (tentativa ${attempt}/${MAX_RETRIES}), aguardando ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Omie HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    return json;
  }
  throw new Error(`Omie: rate limit excedido após ${MAX_RETRIES} tentativas`);
}

// Campos que NÃO devem ser sobrescritos (preenchidos por outros syncs)
const PRESERVE_FIELDS = new Set([
  "id",
  "created_at",
  "t2_data_faturamento",
  "t3_data_cte",
  "t4_data_recebimento",
  "nfe_chave_acesso",
  "nfe_numero",
  "nfe_serie",
  "cte_chave_acesso",
  "cte_numero",
  "numero_pedido_fornecedor",
  "infcpl_raw",
  "transportadora_cnpj",
  "transportadora_nome",
  "representante_codigo",
  "representante_nome",
  "lt_bruto_dias_uteis",
  "lt_faturamento_dias_uteis",
  "lt_logistica_dias_uteis",
]);

function mapPedidoToRow(empresa: Empresa, pedido: any): Record<string, unknown> {
  const cab = pedido?.cabecalho ?? {};
  const info = pedido?.informacoes_cadastro ?? {};

  const cancelado = info?.dCancelado && String(info.dCancelado).trim() !== "";
  const status = cancelado ? "CANCELADO" : "CRIADO";

  return {
    empresa,
    omie_codigo_pedido: cab?.nCodPedido ?? null,
    omie_codigo_integracao: cab?.cCodIntPedido ?? null,
    numero_pedido: cab?.cNumero ?? null,
    fornecedor_codigo_omie: cab?.nCodFor ?? null,
    grupo_leadtime: "OUTRO",
    status,
    t1_data_pedido: parseBRDateToISO(cab?.dInclusao, cab?.hInclusao),
    data_previsao_original: parseBRDateOnly(cab?.dDtPrevisao),
    observacoes: cab?.cObs ?? null,
    raw_data: pedido,
  };
}

async function upsertPedido(
  supabase: ReturnType<typeof createClient>,
  row: Record<string, unknown>,
): Promise<void> {
  if (!row.omie_codigo_pedido) {
    throw new Error("Pedido sem nCodPedido");
  }

  // Estratégia: SELECT existente -> se existe, faz UPDATE preservando campos; senão INSERT
  const { data: existing, error: selErr } = await supabase
    .from("purchase_orders_tracking")
    .select("id")
    .eq("empresa", row.empresa)
    .eq("omie_codigo_pedido", row.omie_codigo_pedido)
    .maybeSingle();

  if (selErr) throw selErr;

  if (existing?.id) {
    // Remove campos preservados do update
    const updateRow: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!PRESERVE_FIELDS.has(k)) updateRow[k] = v;
    }
    updateRow.updated_at = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("purchase_orders_tracking")
      .update(updateRow)
      .eq("id", existing.id);
    if (updErr) throw updErr;
  } else {
    const { error: insErr } = await supabase
      .from("purchase_orders_tracking")
      .insert(row);
    if (insErr) throw insErr;
  }
}

async function syncEmpresa(
  supabase: ReturnType<typeof createClient>,
  empresa: Empresa,
  dias: number,
  fornecedorCodigo: number | undefined,
): Promise<EmpresaSummary> {
  const summary: EmpresaSummary = {
    empresa,
    total_paginas: 0,
    pedidos_sincronizados: 0,
    erros: 0,
  };

  const { app_key, app_secret } = getCredentials(empresa);

  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - dias);
  const dataDe = formatDateBR(inicio);
  const dataAte = formatDateBR(hoje);

  let pagina = 1;
  let totalPaginas = 1;

  while (pagina <= totalPaginas) {
    let resp: any;
    try {
      resp = await callOmie(app_key, app_secret, pagina, dataDe, dataAte, fornecedorCodigo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} erro fetch: ${msg}`);
      summary.erros++;
      break;
    }

    if (resp?.faultstring) {
      const fs = String(resp.faultstring);
      // Sem resultados → encerra paginação limpa
      if (/not\s*found|sem\s*registros|n[ãa]o\s*encontrado/i.test(fs)) {
        console.log(`[sync-pedidos] empresa=${empresa} pagina=${pagina} sem resultados - encerrando`);
        break;
      }
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} faultstring: ${fs}`);
      summary.erros++;
      break;
    }

    totalPaginas = resp?.total_de_paginas ?? 1;
    let pedidos: any[] = resp?.pedido_compra_produto ?? [];

    // Filtro pós-resposta caso a API retorne pedidos de outros fornecedores
    if (fornecedorCodigo) {
      const before = pedidos.length;
      pedidos = pedidos.filter((p) => p?.cabecalho?.nCodFor === fornecedorCodigo);
      if (before !== pedidos.length) {
        console.log(
          `[sync-pedidos] empresa=${empresa} pagina=${pagina} filtro fornecedor: ${before} → ${pedidos.length}`,
        );
      }
    }

    console.log(
      `[sync-pedidos] empresa=${empresa} pagina=${pagina} recebidos=${pedidos.length} (total_paginas=${totalPaginas})`,
    );

    for (const pedido of pedidos) {
      try {
        const row = mapPedidoToRow(empresa, pedido);
        await upsertPedido(supabase, row);
        summary.pedidos_sincronizados++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const codigo = pedido?.cabecalho?.nCodPedido;
        console.error(`[sync-pedidos] empresa=${empresa} pedido=${codigo} erro upsert: ${msg}`);
        summary.erros++;
      }
    }

    summary.total_paginas = pagina;
    pagina++;

    if (pagina <= totalPaginas) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  return summary;
}

// ===== Handler =====
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const t0 = Date.now();

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ ok: false, error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    let body: RequestBody = {};
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const empresaParam = (body.empresa ?? "ALL").toUpperCase() as "OBEN" | "COLACOR" | "ALL";
    const dias = typeof body.dias === "number" && body.dias > 0 ? body.dias : 30;
    const fornecedorCodigo = body.fornecedor_codigo_omie;

    const empresas: Empresa[] =
      empresaParam === "ALL" ? ["OBEN", "COLACOR"] : [empresaParam as Empresa];

    console.log(
      `[sync-pedidos] início empresas=${empresas.join(",")} dias=${dias} fornecedor=${fornecedorCodigo ?? "todos"}`,
    );

    const summary: EmpresaSummary[] = [];
    for (const empresa of empresas) {
      try {
        const s = await syncEmpresa(supabase, empresa, dias, fornecedorCodigo);
        summary.push(s);
        console.log(
          `[sync-pedidos] empresa=${empresa} TOTAL: paginas=${s.total_paginas} pedidos=${s.pedidos_sincronizados} erros=${s.erros} duracao=${Date.now() - t0}ms`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-pedidos] empresa=${empresa} erro fatal: ${msg}`);
        summary.push({
          empresa,
          total_paginas: 0,
          pedidos_sincronizados: 0,
          erros: 1,
        });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        duracao_ms: Date.now() - t0,
        sayerlack: SAYERLACK,
        summary,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync-pedidos] erro fatal:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg, duracao_ms: Date.now() - t0 }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
