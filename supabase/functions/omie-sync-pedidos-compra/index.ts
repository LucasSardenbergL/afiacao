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

const PAGE_SIZE = 100; // MÁXIMO do PesquisarPedCompra — o Omie IGNORA >100 (sync.md); 100>50 corta as páginas pela metade
const RATE_LIMIT_DELAY_MS = 1100;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

// [fix paginação+janela 2026-06-26] espelho de omie-sync-estoque (#979/#1009/#1072) — MESMA armadilha Omie:
// (a) PAGINAÇÃO — o nTotalPaginas SUB-REPORTA em listas grandes → confiar nele PARAVA a captura na 1ª página
//     (pedidos 1079+ sumiam do espelho purchase_orders_tracking). Paginar ATÉ A PÁGINA VAZIA + fingerprint
//     anti-loop + teto técnico FATAL.
// (b) JANELA — dDataInicial/dDataFinal do PesquisarPedCompra filtram pela DATA DE PREVISÃO DE ENTREGA
//     (dDtPrevisao), NÃO pela criação (provado no #1072, mesmo PO 1085). Com dDataFinal=hoje, todo pedido com
//     entrega FUTURA (= recém-feito, dentro do lead time) sumia. A janela cobre previsões PASSADAS e FUTURAS.
const JANELA_PASSADO_DIAS = 365;      // previsão atrasada: PO aberto não-recebido com entrega já vencida
const JANELA_PASSADO_MAX_DIAS = 1095; // teto do override `dias` (backfill manual) — 3 anos; evita janela absurda
const JANELA_FUTURO_DIAS = 120;       // previsão à frente: pedido em trânsito dentro do lead time
const MAX_PAGINAS = 200;              // teto técnico FATAL anti-loop (a janela ~485d cabe MUITO abaixo disso)
// fault do Omie que significa "fim legítimo" (sem registros), NÃO erro. Espelho VERBATIM de
// pendente-entrada-po.ts:FIM_SEM_REGISTROS (testada) via omie-sync-estoque.
const FIM_SEM_REGISTROS =
  /(\bsem\s+registros?\b|\bnenhum\s+registros?\b|n[ãa]o\s+(existem?|h[áa])\s+registros?\b|n[ãa]o\s+foram\s+encontrad\w*\s+registros?\b|\bregistros?\s+n[ãa]o\s+(existem?|foram\s+encontrad\w*|encontrad\w*)\b)/i;

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

    // [fix paginação] O Omie sinaliza FIM DE PÁGINAS com HTTP 500 + faultstring "Não existem registros para a
    // página [N]" (faultcode 5113), NÃO com 200+lista-vazia. Sem isto, o throw em !res.ok mataria a paginação-
    // até-vazia na 1ª página-além-do-fim. Devolve o json p/ o loop tratar como fim (via FIM_SEM_REGISTROS).
    if (!res.ok && json?.faultstring && FIM_SEM_REGISTROS.test(json.faultstring)) {
      return json;
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

// Upsert em LOTE (1 chamada/página via uq_pedido_omie = UNIQUE(empresa, omie_codigo_pedido)), NÃO N+1.
// [fix wall-clock] a janela ampla (~485d) traz centenas de pedidos; o SELECT+UPDATE/INSERT por pedido (2
// round-trips × N) estourava o step de 25s do omie-cron-diario. O payload EXCLUI PRESERVE_FIELDS (campos de
// OUTROS syncs: t2/t3/t4, nfe, cte, transportadora, representante, lt_*) → o ON CONFLICT DO UPDATE não os
// toca = preserva o último valor bom (MESMO efeito do upsert seletivo antigo). Fallback individual em erro de
// lote isola a linha torta sem perder a página inteira (espelho de omie-sync-estoque).
async function upsertPedidosLote(
  supabase: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<{ sincronizados: number; erros: number }> {
  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown>[] = [];
  let erros = 0;

  for (const row of rows) {
    // nCodPed ausente → omie_codigo_pedido null não casa o UNIQUE (null≠null no Postgres) → inseriria duplicata
    // órfã a cada sync. Pula e conta erro (mesma guarda do upsert antigo).
    if (row.omie_codigo_pedido === null || row.omie_codigo_pedido === undefined) {
      console.error(`[sync-pedidos] pedido sem nCodPed (numero=${row.numero_pedido ?? "—"}) — pulado`);
      erros++;
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!PRESERVE_FIELDS.has(k)) clean[k] = v;
    }
    clean.updated_at = nowIso;
    payload.push(clean);
  }

  if (payload.length === 0) return { sincronizados: 0, erros };

  const { error } = await supabase
    .from("purchase_orders_tracking")
    .upsert(payload, { onConflict: "empresa,omie_codigo_pedido" });
  if (!error) return { sincronizados: payload.length, erros };

  // Lote falhou (1 linha torta derruba o batch) → individual p/ isolar a culpada e salvar o resto.
  console.error(`[sync-pedidos] erro upsert lote (${payload.length}): ${error.message}. Tentando individual.`);
  let sincronizados = 0;
  for (const row of payload) {
    const { error: e2 } = await supabase
      .from("purchase_orders_tracking")
      .upsert(row, { onConflict: "empresa,omie_codigo_pedido" });
    if (e2) {
      console.error(`[sync-pedidos] erro upsert pedido=${row.omie_codigo_pedido}: ${e2.message}`);
      erros++;
    } else {
      sincronizados++;
    }
  }
  return { sincronizados, erros };
}

// fingerprint barato de página (anti-loop): mesma página NÃO-VAZIA repetida = Omie em loop → abort FATAL.
// Espelho de omie-sync-estoque, adaptado: usa nCodPed (sempre presente) + cNumero do cabeçalho da consulta.
function fingerprintPagina(pedidos: readonly OmiePedido[]): string {
  if (!pedidos || pedidos.length === 0) return "";
  const prim = pedidos[0]?.cabecalho_consulta ?? pedidos[0]?.cabecalho ?? {};
  const ult = pedidos[pedidos.length - 1]?.cabecalho_consulta ?? pedidos[pedidos.length - 1]?.cabecalho ?? {};
  const chave = (c: OmiePedidoCabecalho) =>
    `${String(c?.nCodPed ?? "").trim()}/${String(c?.cNumero ?? "").trim()}`;
  return `${pedidos.length}:${chave(prim)}:${chave(ult)}`;
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
  // [fix janela] o filtro dDataInicial/dDataFinal do PesquisarPedCompra é por DATA DE PREVISÃO DE ENTREGA
  // (dDtPrevisao), não por criação. Janela = passado amplo (atrasados não-recebidos) + futuro (a caminho,
  // dentro do lead time). `dias` (o cron passa 3) só pode AMPLIAR o passado num backfill manual — nunca encolher
  // abaixo de JANELA_PASSADO_DIAS (à prova de erro: o valor incremental do cron não reintroduz o bug de janela).
  const passadoDias = Math.min(
    JANELA_PASSADO_MAX_DIAS,
    Math.max(JANELA_PASSADO_DIAS, Number.isFinite(dias) ? dias : 0),
  );
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - passadoDias);
  const fimJanela = new Date();
  fimJanela.setDate(hoje.getDate() + JANELA_FUTURO_DIAS);
  const dataDe = formatDateBR(inicio);
  const dataAte = formatDateBR(fimJanela);
  console.log(
    `[sync-pedidos] empresa=${empresa} janela previsão ${dataDe}→${dataAte} (passado ${passadoDias}d, futuro ${JANELA_FUTURO_DIAS}d)`,
  );

  // [fix paginação] PAGINA ATÉ A PÁGINA VAZIA — não confiar em nTotalPaginas (Omie SUB-REPORTA → lia só a 1ª
  // página → pedidos 1079+ sumiam). Fingerprint anti-loop por página repetida + teto técnico (espelho do irmão).
  const fpsVistos = new Set<string>();
  let fim = false;       // vi o fim legítimo dos dados (página vazia / fault "sem registros")
  let abortado = false;  // saí por erro/anomalia (fetch, fault real, loop) — já contado em summary.erros

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    let resp: OmieSearchResponse;
    try {
      resp = await callOmie(app_key, app_secret, pagina, dataDe, dataAte);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} erro fetch: ${msg}`);
      summary.erros++;
      abortado = true;
      break;
    }

    if (resp?.faultstring) {
      const fs = String(resp.faultstring);
      if (FIM_SEM_REGISTROS.test(fs)) {
        console.log(`[sync-pedidos] empresa=${empresa} pagina=${pagina} sem registros — fim`);
        fim = true;
        break;
      }
      console.error(`[sync-pedidos] empresa=${empresa} pagina=${pagina} faultstring: ${fs}`);
      summary.erros++;
      abortado = true;
      break;
    }

    let pedidos: OmiePedido[] = resp?.pedidos_pesquisa ?? resp?.pedido_compra_produto ?? resp?.pedidoCompraProduto ?? [];

    if (pedidos.length === 0) { // página vazia = FIM real (não nTotalPaginas)
      fim = true;
      break;
    }

    const fp = fingerprintPagina(pedidos);
    if (fp && fpsVistos.has(fp)) {
      console.error(`[sync-pedidos] empresa=${empresa} REPETIÇÃO de página (pág ${pagina}) — abort anti-loop`);
      summary.erros++;
      abortado = true;
      break;
    }
    fpsVistos.add(fp);

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

    console.log(`[sync-pedidos] empresa=${empresa} pagina=${pagina} recebidos=${pedidos.length}`);

    const rows = pedidos.map((pedido) => mapPedidoToRow(empresa, pedido));
    const upsertRes = await upsertPedidosLote(supabase, rows);
    summary.pedidos_sincronizados += upsertRes.sincronizados;
    summary.erros += upsertRes.erros;

    summary.total_paginas = pagina;
    await sleep(RATE_LIMIT_DELAY_MS); // rate-limit Omie entre páginas
  }

  if (!fim && !abortado) {
    // Esgotou MAX_PAGINAS sem ver o fim (e sem erro pelo caminho). O irmão (estoque) faz THROW aqui (fail-closed,
    // pois alimenta double-buy). AQUI o consumidor é um ESPELHO DE ACOMPANHAMENTO (leadtime/telas), não um
    // gatilho de compra: dado parcial vale mais que derrubar o sync. Registra erro (sinal no summary) e preserva
    // o já capturado (upsert idempotente retoma no próximo ciclo).
    console.error(`[sync-pedidos] empresa=${empresa} excedeu ${MAX_PAGINAS} páginas sem ver fim — abort anti-truncamento`);
    summary.erros++;
  }

  return summary;
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
