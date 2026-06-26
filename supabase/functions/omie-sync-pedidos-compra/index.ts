// Edge Function: omie-sync-pedidos-compra
// Sincroniza pedidos de compra do Omie (Oben + Colacor) para a tabela purchase_orders_tracking
// Pública (verify_jwt = false) - acionada via POST manual ou cron
//
// Método Omie usado: PesquisarPedCompra
// Doc: https://app.omie.com.br/api/v1/produtos/pedidocompra/#PesquisarPedCompra

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

// ===== Omie API shapes (inline — Edge Function não pode importar de @/) =====
interface OmiePedidoCabecalho {
  nCodPed?: number | string | null;
  cCodIntPed?: string | null;
  dIncData?: string | null;
  cIncHora?: string | null;
  cEtapa?: string | null;
  cNumero?: string | null;
  cContrato?: string | null;
  dDtPrevisao?: string | null;
  nCodFor?: number | string | null;
  cObs?: string | null;
  cObsInt?: string | null;
  [key: string]: unknown;
}

interface OmiePedido {
  cabecalho?: OmiePedidoCabecalho;
  cabecalho_consulta?: OmiePedidoCabecalho;
  [key: string]: unknown;
}

interface OmieSearchResponse {
  pedidos_pesquisa?: OmiePedido[];
  pedido_compra_produto?: OmiePedido[];
  pedidoCompraProduto?: OmiePedido[];
  nTotalPaginas?: number;
  nTotalRegistros?: number;
  nPagina?: number;
  faultstring?: string;
  faultcode?: string;
  raw?: string;
  [key: string]: unknown;
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
): Promise<OmieSearchResponse> {
  // PesquisarPedCompra NÃO suporta filtro nativo por fornecedor.
  // Filtramos pós-resposta em syncEmpresa().
  const param: Record<string, unknown> = {
    nPagina: pagina,
    nRegsPorPagina: PAGE_SIZE,
    lApenasImportadoApi: "F",
    lExibirPedidosPendentes: "T",
    lExibirPedidosFaturados: "T",
    lExibirPedidosRecebidos: "T",
    lExibirPedidosCancelados: "T",
    lExibirPedidosEncerrados: "T",
    lExibirPedidosRecParciais: "T",
    lExibirPedidosFatParciais: "T",
    dDataInicial: dataDe,
    dDataFinal: dataAte,
  };

  const body = {
    call: "PesquisarPedCompra",
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
    let json: OmieSearchResponse;
    try {
      json = JSON.parse(text) as OmieSearchResponse;
    } catch {
      json = { raw: text };
    }

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

/**
 * Mapeia um pedido retornado por PesquisarPedCompra → linha de purchase_orders_tracking.
 * Estrutura do retorno (pedidos_pesquisa[]):
 *   {
 *     cabecalho: { nCodPed, cCodIntPed, dIncData, cIncHora, cEtapa, cNumero,
 *                  dDtPrevisao, nCodFor, cObs, cObsInt, ... }
 *     ...
 *   }
 * Status derivado de cEtapa (etapas Omie):
 *   "10"=Digitação, "20"=Aprovação, "50"=Aprovado, "60"=Faturado,
 *   "70"=Recebido, "80"=Encerrado, "90"=Cancelado
 */
function mapPedidoToRow(empresa: Empresa, pedido: OmiePedido): Record<string, unknown> {
  // PesquisarPedCompra retorna o cabeçalho em "cabecalho_consulta" (não "cabecalho")
  const cab = pedido?.cabecalho_consulta ?? pedido?.cabecalho ?? {};
  const etapa = String(cab?.cEtapa ?? "").trim();

  let status = "CRIADO";
  if (etapa === "90") status = "CANCELADO";
  else if (etapa === "80") status = "ENCERRADO";
  else if (etapa === "70") status = "RECEBIDO";
  else if (etapa === "60") status = "FATURADO";

  return {
    empresa,
    omie_codigo_pedido: cab?.nCodPed ?? null,
    omie_codigo_integracao: cab?.cCodIntPed ?? null,
    numero_pedido: cab?.cNumero ?? null,
    numero_contrato_fornecedor: cab?.cContrato
      ? String(cab.cContrato).trim() || null
      : null,
    fornecedor_codigo_omie: cab?.nCodFor ?? null,
    grupo_leadtime: "OUTRO",
    status,
    t1_data_pedido: parseBRDateToISO(cab?.dIncData, cab?.cIncHora),
    data_previsao_original: parseBRDateOnly(cab?.dDtPrevisao),
    observacoes: cab?.cObs ?? null,
    raw_data: pedido,
  };
}

async function upsertPedido(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  if (!row.omie_codigo_pedido) {
    throw new Error("Pedido sem nCodPed");
  }

  const { data: existing, error: selErr } = await supabase
    .from("purchase_orders_tracking")
    .select("id")
    .eq("empresa", row.empresa as string)
    .eq("omie_codigo_pedido", row.omie_codigo_pedido as string | number)
    .maybeSingle();

  if (selErr) throw selErr;

  if (existing?.id) {
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
  supabase: SupabaseClient,
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
    let resp: OmieSearchResponse;
    try {
      resp = await callOmie(app_key, app_secret, pagina, dataDe, dataAte);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} erro fetch: ${msg}`);
      summary.erros++;
      break;
    }

    if (resp?.faultstring) {
      const fs = String(resp.faultstring);
      if (/not\s*found|sem\s*registros|n[ãa]o\s*encontrado/i.test(fs)) {
        console.log(`[sync-pedidos] empresa=${empresa} pagina=${pagina} sem resultados - encerrando`);
        break;
      }
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} faultstring: ${fs}`);
      summary.erros++;
      break;
    }

    totalPaginas = resp?.nTotalPaginas ?? 1;
    let pedidos: OmiePedido[] = resp?.pedidos_pesquisa ?? resp?.pedido_compra_produto ?? resp?.pedidoCompraProduto ?? [];

    // DEBUG: log shape do primeiro pedido (página 1) e top-level keys
    if (pagina === 1) {
      console.log(`[sync-pedidos] DEBUG top-level keys: ${JSON.stringify(Object.keys(resp || {}))}`);
      if (pedidos.length > 0) {
        console.log(`[sync-pedidos] SHAPE primeiro pedido: ${JSON.stringify(pedidos[0], null, 2).slice(0, 4000)}`);
      }
    }

    // Filtro pós-resposta por fornecedor (PesquisarPedCompra não filtra nativamente)
    if (fornecedorCodigo) {
      const before = pedidos.length;
      pedidos = pedidos.filter(
        (p) => Number(p?.cabecalho_consulta?.nCodFor ?? p?.cabecalho?.nCodFor) === Number(fornecedorCodigo),
      );
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
        const codigo = pedido?.cabecalho_consulta?.nCodPed ?? pedido?.cabecalho?.nCodPed;
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

// ===== Heartbeat do Sentinela (sync_state) =====
// Marcador 1-writer dedicado: entity_type='pedidos_compra', account=<empresa minúscula>.
// O check pedidos_compra_sync em _data_health_compute() lê este marcador.
//   last_sync_at = horário do último SUCESSO (complete/partial) — NÃO avança em falha total,
//                  para preservar "última coleta boa" ao operador.
//   updated_at   = heartbeat de execução (todo upsert o avança) — usado p/ detectar 'running' órfão.
//   status       = running → complete | partial | error.
//   metadata     = { trigger, dias, ... } para auditoria (qual execução o marcador representa).
// purchase_orders_tracking é multi-writer (nfes/ctes/sku-items também escrevem updated_at), então
// frescor pela tabela NÃO isola este sync — daí o marcador dedicado. Só gravado em sync ABRANGENTE
// (sem fornecedor específico); investigação manual por-fornecedor não polui o sinal.
const HEARTBEAT_ENTITY = "pedidos_compra";

async function heartbeatRunning(
  supabase: SupabaseClient,
  empresa: Empresa,
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await supabase.from("sync_state").upsert(
      {
        entity_type: HEARTBEAT_ENTITY,
        account: empresa.toLowerCase(),
        status: "running",
        updated_at: new Date().toISOString(),
        metadata: { ...meta, started_at: new Date().toISOString() },
      },
      { onConflict: "entity_type,account" },
    );
    if (error) throw error;
  } catch (err) {
    // Heartbeat é best-effort: nunca derruba o sync por causa do marcador.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] heartbeat running falhou empresa=${empresa}: ${msg}`);
  }
}

async function heartbeatFim(
  supabase: SupabaseClient,
  s: EmpresaSummary,
  meta: Record<string, unknown>,
  errFatal: string | null,
): Promise<void> {
  const nowISO = new Date().toISOString();
  // Falha TOTAL (0 sincronizados + erros>0) → 'error' SEM avançar last_sync_at (preserva último sucesso).
  // Parcial (algum progresso + erros)      → 'partial' COM last_sync_at (houve coleta, mas truncada).
  // Sucesso (0 erros, mesmo 0 pedidos = janela vazia legítima) → 'complete' COM last_sync_at.
  const falhaTotal = s.pedidos_sincronizados === 0 && s.erros > 0;
  const parcial = s.pedidos_sincronizados > 0 && s.erros > 0;
  const row: Record<string, unknown> = {
    entity_type: HEARTBEAT_ENTITY,
    account: s.empresa.toLowerCase(),
    status: falhaTotal ? "error" : parcial ? "partial" : "complete",
    updated_at: nowISO,
    total_synced: s.pedidos_sincronizados,
    error_message: s.erros > 0
      ? (errFatal ?? `${s.erros} erro(s) na coleta, ${s.pedidos_sincronizados} sincronizado(s)`)
      : null,
    metadata: { ...meta, finished_at: nowISO, erros: s.erros, total_paginas: s.total_paginas },
  };
  // last_sync_at só avança quando houve progresso (complete/partial). Em falha total, OMITIMOS a coluna
  // → o upsert não a sobrescreve (mantém o horário do último sucesso). Coluna ausente em 1º run = NULL.
  if (!falhaTotal) row.last_sync_at = nowISO;
  try {
    const { error } = await supabase.from("sync_state").upsert(row, { onConflict: "entity_type,account" });
    if (error) throw error;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] heartbeat fim falhou empresa=${s.empresa}: ${msg}`);
  }
}

// ===== Handler =====
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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

    // Heartbeat do Sentinela só em sync ABRANGENTE (sem fornecedor específico) — investigação manual
    // filtrada por fornecedor não representa o frescor geral e não deve sobrescrever o marcador do cron.
    const gravaHeartbeat = !fornecedorCodigo;
    const heartbeatMeta = { trigger: req.headers.get("x-cron-secret") ? "cron" : "manual", dias };

    const summary: EmpresaSummary[] = [];
    for (const empresa of empresas) {
      if (gravaHeartbeat) await heartbeatRunning(supabase, empresa, heartbeatMeta);
      let s: EmpresaSummary;
      let errFatal: string | null = null;
      try {
        s = await syncEmpresa(supabase, empresa, dias, fornecedorCodigo);
        console.log(
          `[sync-pedidos] empresa=${empresa} TOTAL: paginas=${s.total_paginas} pedidos=${s.pedidos_sincronizados} erros=${s.erros} duracao=${Date.now() - t0}ms`,
        );
      } catch (err) {
        errFatal = err instanceof Error ? err.message : String(err);
        console.error(`[sync-pedidos] empresa=${empresa} erro fatal: ${errFatal}`);
        s = { empresa, total_paginas: 0, pedidos_sincronizados: 0, erros: 1 };
      }
      summary.push(s);
      if (gravaHeartbeat) await heartbeatFim(supabase, s, heartbeatMeta, errFatal);
    }

    // Fail-CLOSED na coleta total: 0 sincronizados em TODAS as empresas + algum erro → não-2xx, para
    // logs/dashboard do Supabase e chamada DIRETA enxergarem. (Janela vazia legítima = 0 sinc + 0 erros
    // → 200 ok.) ⚠️ Mascarado pelo orquestrador omie-cron-diario (sempre 200) — a detecção do Sentinela
    // vem do heartbeat sync_state acima, não deste status HTTP.
    const algumSucesso = summary.some((x) => x.pedidos_sincronizados > 0);
    const totalErros = summary.reduce((a, x) => a + x.erros, 0);
    const falhaTotalGeral = !algumSucesso && totalErros > 0;

    return new Response(
      JSON.stringify({
        ok: !falhaTotalGeral,
        duracao_ms: Date.now() - t0,
        sayerlack: SAYERLACK,
        summary,
      }),
      {
        status: falhaTotalGeral ? 502 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
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
