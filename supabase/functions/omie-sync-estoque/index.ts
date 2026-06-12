// Edge function: omie-sync-estoque
// Sincroniza estoque físico (ListarPosEstoque) e o "a caminho" (estoque_pendente_entrada) de SKUs
// habilitados para reposição automática.
//
// ⚠️ "A caminho" da OBEN = FONTE ÚNICA Omie (Opção A endurecida; spec 2026-06-11-reposicao-fonte-unica-on-order):
//   Σ saldo (nQtde − nQtdeRec) por SKU sobre as POs abertas APROVADAS (etapa "15"), app+manual. O em_transito
//   da RPC gerar_pedidos foi REMOVIDO (keep-both → overcount → ruptura; bloqueado pelo Codex). A QUANTIDADE
//   não tem 2ª fonte; a latência do recém-disparado é coberta pela barreira fail-closed do motor (passo 3) +
//   bump {only_pending, esperar_codints} no disparo (passo 4). COLACOR mantém ListarSaldoPendente (não-objetivo v1).
//
// Gravação do "a caminho" = RPC aplicar_snapshot_pendente (atômica: SUBSTITUI todo o pendente OBEN + marcador
//   `complete` na MESMA transação; run_id monotônico). A edge é a coletora; a RPC é a dona da coluna.
//
// Invocação:
//  - Cron (físico + a caminho): POST { empresa: "OBEN" }            → full
//  - Bump pós-disparo (só a caminho): POST { empresa: "OBEN", only_pending: true, esperar_codints: ["AFI-<id>"] }
//  - Manual: POST { empresa: "OBEN" | "COLACOR" }

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders as sharedCors } from "../_shared/auth.ts";

const corsHeaders = {
  ...sharedCors,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/estoque/consulta/";
const OMIE_ENDPOINT_PEDIDOS = "https://app.omie.com.br/api/v1/produtos/pedidocompra/";
const PAGE_SIZE = 500;
const MAX_RETRIES = 3;

// PesquisarPedCompra — paginar ATÉ A PÁGINA VAZIA (o nTotalPaginas do Omie SUB-REPORTA em listas grandes;
// já mordeu CR/CP em omie-financeiro → PO omitida = double-buy). Sem corte de data (todas as POs abertas).
const PEDIDOS_REGS_POR_PAGINA = 50;
const PEDIDOS_MAX_PAGINAS = 2000;          // teto técnico FATAL anti-loop (~100k POs, muito acima do real)
const PEDIDOS_DATA_INICIAL = "01/01/2010"; // antes do início operacional — SEM corte de janela
const ESPERA_CODINTS_TENTATIVAS = 4;       // bump: re-varre até ver os AFI-<id> recém-disparados
const ESPERA_CODINTS_BACKOFF_MS = 1500;
const ETAPAS_APROVADO_ABERTO = new Set<string>(["15"]); // OBEN: 15=Aprovado (confirmado 2026-06-11)
const ETAPAS_IGNORADAS = new Set<string>(["10"]);        // OBEN: 10=Em Aprovação (não comprometido)

type Empresa = "OBEN" | "COLACOR";

// Item do método ListarPosEstoque (response.produtos[])
interface OmiePosEstoqueItem {
  nCodProd?: number;
  fisico?: number;
  reservado?: number;
  nPendente?: number; // pendente em pedidos de VENDA (saída) — NÃO usado p/ o "a caminho"
  [k: string]: unknown;
}
interface OmiePosEstoqueResponse {
  nTotPaginas?: number;
  nTotRegistros?: number;
  produtos?: OmiePosEstoqueItem[];
  faultcode?: string;
  faultstring?: string;
}

// Item do método ListarSaldoPendente (COLACOR)
interface OmieSaldoPendenteItem { id_prod?: number; qtde_entrada?: number; [k: string]: unknown; }
interface OmieSaldoPendenteResponse {
  total_de_paginas?: number;
  saldo_pendente_lista?: OmieSaldoPendenteItem[];
  faultcode?: string;
  faultstring?: string;
}

// =====================================================================================================
// ── ESPELHO VERBATIM de src/lib/reposicao/pendente-entrada-po.ts (Deno não importa de src/; 36 testes vitest) ──
// =====================================================================================================
interface PoItemOmie { sku: string; poNumero: string; etapa: string; qtde: number; recebido: number; }
interface ComputeOnOrderOpts { etapasAprovadas: ReadonlySet<string>; etapasIgnoradas: ReadonlySet<string>; }
interface ComputeOnOrderResult { porSku: Map<string, number>; problemas: string[]; }
function quantidadesValidas(qtde: number, recebido: number): boolean {
  return Number.isFinite(qtde) && Number.isFinite(recebido) && qtde >= 0 && recebido >= 0;
}
function saldoAReceber(qtde: number, recebido: number): number {
  return Math.max(0, qtde - recebido);
}
function computeOnOrder(items: readonly PoItemOmie[], opts: ComputeOnOrderOpts): ComputeOnOrderResult {
  const porSku = new Map<string, number>();
  const problemas: string[] = [];
  for (const item of items) {
    if (!quantidadesValidas(item.qtde, item.recebido)) {
      problemas.push(`quantidade inválida (sku=${item.sku} po=${item.poNumero} qtde=${item.qtde} recebido=${item.recebido})`);
      continue;
    }
    const saldo = saldoAReceber(item.qtde, item.recebido);
    if (saldo <= 0) continue;
    if (opts.etapasAprovadas.has(item.etapa)) {
      porSku.set(item.sku, (porSku.get(item.sku) ?? 0) + saldo);
    } else if (opts.etapasIgnoradas.has(item.etapa)) {
      continue;
    } else {
      problemas.push(`etapa aberta desconhecida com saldo (etapa=${item.etapa} sku=${item.sku} po=${item.poNumero})`);
    }
  }
  return { porSku, problemas };
}
interface OmiePedItemRaw { nCodProd?: number | string; nQtde?: number; nQtdeRec?: number; [k: string]: unknown; }
interface OmiePedCabRaw { cNumero?: number | string; cCodIntPed?: string; cEtapa?: string; [k: string]: unknown; }
interface OmiePedConsultaRaw { cabecalho_consulta?: OmiePedCabRaw; cabecalho?: OmiePedCabRaw; produtos_consulta?: OmiePedItemRaw[]; [k: string]: unknown; }
interface ColetaPaginaOpts { etapasAprovadas: ReadonlySet<string>; skusHabilitados?: ReadonlySet<string>; }
interface ColetaPaginaResult { items: PoItemOmie[]; codintsAprovados: string[]; pedidosVistos: number; etapasVistas: string[]; }
function norm(v: unknown): string { return String(v ?? "").trim(); }
function coletarDaPagina(pedidos: readonly OmiePedConsultaRaw[] | undefined, opts: ColetaPaginaOpts): ColetaPaginaResult {
  const items: PoItemOmie[] = [];
  const codints: string[] = [];
  const etapasVistas = new Set<string>();
  const lista = pedidos ?? [];
  for (const ped of lista) {
    const cab = ped?.cabecalho_consulta ?? ped?.cabecalho ?? {};
    const etapa = norm(cab.cEtapa);
    const cNumero = norm(cab.cNumero);
    const cCodIntPed = norm(cab.cCodIntPed);
    if (etapa) etapasVistas.add(etapa);
    if (opts.etapasAprovadas.has(etapa) && cCodIntPed) codints.push(cCodIntPed);
    for (const it of ped?.produtos_consulta ?? []) {
      const sku = norm(it.nCodProd);
      if (!sku) continue;
      if (opts.skusHabilitados && !opts.skusHabilitados.has(sku)) continue;
      items.push({ sku, poNumero: cNumero, etapa, qtde: Number(it.nQtde ?? 0), recebido: Number(it.nQtdeRec ?? 0) });
    }
  }
  return { items, codintsAprovados: codints, pedidosVistos: lista.length, etapasVistas: [...etapasVistas] };
}
function paginaVazia(pedidos: readonly OmiePedConsultaRaw[] | undefined): boolean {
  return !pedidos || pedidos.length === 0;
}
function fingerprintPagina(pedidos: readonly OmiePedConsultaRaw[] | undefined): string {
  const peds = pedidos ?? [];
  if (peds.length === 0) return "";
  const prim = peds[0]?.cabecalho_consulta ?? peds[0]?.cabecalho ?? {};
  const ult = peds[peds.length - 1]?.cabecalho_consulta ?? peds[peds.length - 1]?.cabecalho ?? {};
  return `${peds.length}:${norm(prim.cNumero)}:${norm(ult.cNumero)}`;
}
function codintsFaltantes(esperados: readonly string[], vistos: readonly string[]): string[] {
  const set = new Set(vistos.map((v) => v.trim()).filter(Boolean));
  const out: string[] = [];
  for (const e of esperados) {
    const k = (e ?? "").trim();
    if (k && !set.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}
interface PaginaPedidos { pedidos?: OmiePedConsultaRaw[]; faultstring?: string; }
interface VarrerPedidosOpts { etapasAprovadas: ReadonlySet<string>; skusHabilitados?: ReadonlySet<string>; maxPaginas: number; }
interface VarrerPedidosResult { items: PoItemOmie[]; codintsAprovados: string[]; etapasVistas: string[]; pedidosVistos: number; paginasLidas: number; }
const FIM_SEM_REGISTROS =
  /(not\s*found|sem\s+registros?\b|nenhum\s+registro|n[ãa]o\s+(existem?|h[áa]|foram|foi|possui|cont[ée]m|retornou)\b.{0,30}\bregistros?\b)/i;
async function varrerPedidos(
  fetchPagina: (pagina: number) => Promise<PaginaPedidos>,
  opts: VarrerPedidosOpts,
): Promise<VarrerPedidosResult> {
  const items: PoItemOmie[] = [];
  const codints = new Set<string>();
  const etapas = new Set<string>();
  let pedidosVistos = 0;
  let paginasLidas = 0;
  let fpAnterior = "";
  let fim = false;
  for (let pagina = 1; pagina <= opts.maxPaginas; pagina++) {
    const resp = await fetchPagina(pagina);
    if (resp.faultstring) {
      if (FIM_SEM_REGISTROS.test(resp.faultstring)) { fim = true; break; }
      throw new Error(`PesquisarPedCompra fault: ${resp.faultstring}`);
    }
    const pedidos = resp.pedidos ?? [];
    if (paginaVazia(pedidos)) { fim = true; break; }
    const fp = fingerprintPagina(pedidos);
    if (fp !== "" && fp === fpAnterior) {
      throw new Error(`PesquisarPedCompra LOOP (pág ${pagina} idêntica à anterior; fp=${fp}) — abortando p/ não double-buy`);
    }
    fpAnterior = fp;
    paginasLidas++;
    const c = coletarDaPagina(pedidos, { etapasAprovadas: opts.etapasAprovadas, skusHabilitados: opts.skusHabilitados });
    for (const it of c.items) items.push(it);
    for (const cc of c.codintsAprovados) codints.add(cc);
    for (const e of c.etapasVistas) etapas.add(e);
    pedidosVistos += c.pedidosVistos;
  }
  if (!fim) throw new Error(`PesquisarPedCompra excedeu ${opts.maxPaginas} páginas sem ver fim — abortando (anti-truncamento)`);
  return { items, codintsAprovados: [...codints], etapasVistas: [...etapas], pedidosVistos, paginasLidas };
}
// ── fim do espelho verbatim ──

function ddmmyyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function callOmie<T>(
  appKey: string, appSecret: string, call: string, param: Record<string, unknown>,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OMIE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call, app_key: appKey, app_secret: appSecret, param: [param] }),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`AUTH_ERROR ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as T & { faultcode?: string; faultstring?: string };
      if (json.faultcode) throw new Error(`Omie fault ${json.faultcode}: ${json.faultstring}`);
      return json;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("AUTH_ERROR")) throw err;
      const wait = 1000 * Math.pow(2, attempt - 1);
      console.warn(`[omie-sync-estoque] ${call} attempt ${attempt}/${MAX_RETRIES} falhou: ${msg}. retry em ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error("Falha desconhecida ao chamar Omie");
}

function getOmieCredentials(empresa: Empresa) {
  if (empresa === "OBEN") {
    return { appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "", appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "" };
  }
  return { appKey: Deno.env.get("OMIE_COLACOR_APP_KEY") ?? "", appSecret: Deno.env.get("OMIE_COLACOR_APP_SECRET") ?? "" };
}

interface OmiePedResponse {
  pedidos_pesquisa?: OmiePedConsultaRaw[];
  nTotalPaginas?: number;
  faultstring?: string;
  faultcode?: string;
  [k: string]: unknown;
}

// PesquisarPedCompra com retry/backoff robusto: rede/5xx/429/timeout/não-JSON/fault-de-rate retentam;
// auth (401/403) falha de imediato. SEM corte de janela (dDataInicial fixo antigo, dDataFinal=hoje+1).
async function callOmiePedidos(appKey: string, appSecret: string, pagina: number): Promise<OmiePedResponse> {
  const amanha = ddmmyyyy(new Date(Date.now() + 24 * 3600 * 1000));
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OMIE_ENDPOINT_PEDIDOS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call: "PesquisarPedCompra",
          app_key: appKey,
          app_secret: appSecret,
          param: [{
            nPagina: pagina,
            nRegsPorPagina: PEDIDOS_REGS_POR_PAGINA,
            lApenasImportadoApi: "F",
            lExibirPedidosPendentes: "T",
            lExibirPedidosFaturados: "T",
            lExibirPedidosRecParciais: "T",
            lExibirPedidosFatParciais: "T",
            lExibirPedidosRecebidos: "F",
            lExibirPedidosCancelados: "F",
            lExibirPedidosEncerrados: "F",
            dDataInicial: PEDIDOS_DATA_INICIAL,
            dDataFinal: amanha,
          }],
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`AUTH_ERROR ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`RETRYABLE ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`PesquisarPedCompra HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const text = await res.text();
      let json: OmiePedResponse;
      try { json = JSON.parse(text) as OmiePedResponse; }
      catch { throw new Error(`RETRYABLE não-JSON: ${text.slice(0, 200)}`); }
      if (json.faultstring && /(rate limit|timeout|tente novamente|servi[çc]o indispon[íi]vel)/i.test(json.faultstring)) {
        throw new Error(`RETRYABLE fault: ${json.faultstring}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("AUTH_ERROR")) throw err;
      if (attempt < MAX_RETRIES) {
        const wait = 1500 * Math.pow(2, attempt - 1); // 1.5s, 3s
        console.warn(`[omie-sync-estoque] PesquisarPedCompra pág ${pagina} ${attempt}/${MAX_RETRIES}: ${msg}. retry ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr ?? new Error("PesquisarPedCompra: falha após retries");
}

interface OnOrderColeta {
  porSku: Record<string, number>;
  codints: string[];
  problemas: string[];
  paginasLidas: number;
  pedidosVistos: number;
  etapasVistas: string[];
}

// Varre TODAS as POs abertas (varrerPedidos: paginar até página vazia + anti-loop + teto fatal) e deriva
// o "a caminho" por SKU via computeOnOrder. O fetchPagina injetado faz callOmiePedidos + sleep de rate-limit.
// problemas != [] NÃO é fatal aqui — volta no resultado p/ o caller abortar o apply (mantendo o snapshot).
async function coletarOnOrder(
  appKey: string, appSecret: string, habilitadoSet: ReadonlySet<string>,
): Promise<OnOrderColeta> {
  let primeira = true;
  const fetchPagina = async (pagina: number): Promise<PaginaPedidos> => {
    if (!primeira) await new Promise((r) => setTimeout(r, 1100)); // rate-limit do Omie entre páginas
    primeira = false;
    const resp = await callOmiePedidos(appKey, appSecret, pagina);
    return { pedidos: resp.pedidos_pesquisa, faultstring: resp.faultstring };
  };
  const v = await varrerPedidos(fetchPagina, {
    etapasAprovadas: ETAPAS_APROVADO_ABERTO, skusHabilitados: habilitadoSet, maxPaginas: PEDIDOS_MAX_PAGINAS,
  });
  const { porSku, problemas } = computeOnOrder(v.items, {
    etapasAprovadas: ETAPAS_APROVADO_ABERTO, etapasIgnoradas: ETAPAS_IGNORADAS,
  });
  const porSkuObj: Record<string, number> = {};
  for (const [k, val] of porSku) porSkuObj[k] = val;
  return {
    porSku: porSkuObj, codints: v.codintsAprovados, problemas,
    paginasLidas: v.paginasLidas, pedidosVistos: v.pedidosVistos, etapasVistas: v.etapasVistas,
  };
}

async function computePendenteViaSaldoPendente(
  appKey: string, appSecret: string, habilitadoMap: Map<string, string | null>,
): Promise<Map<string, number>> {
  const pendente = new Map<string, number>();
  let pPag = 1, pTot = 1;
  do {
    const resp = await callOmie<OmieSaldoPendenteResponse>(
      appKey, appSecret, "ListarSaldoPendente",
      { pagina: pPag, registros_por_pagina: PAGE_SIZE, tipo: "ENTRADA" },
    );
    pTot = resp.total_de_paginas ?? 1;
    for (const item of resp.saldo_pendente_lista ?? []) {
      const codigo = String(item.id_prod ?? "").trim();
      if (!codigo || !habilitadoMap.has(codigo)) continue;
      pendente.set(codigo, (pendente.get(codigo) ?? 0) + Number(item.qtde_entrada ?? 0));
    }
    pPag++;
  } while (pPag <= pTot);
  console.log(`[omie-sync-estoque] ListarSaldoPendente (COLACOR): ${pendente.size} SKUs com entrada pendente.`);
  return pendente;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const startedAt = new Date();
  const t0 = performance.now();

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const empresa: Empresa = (body?.empresa ?? "OBEN") as Empresa;
    if (empresa !== "OBEN" && empresa !== "COLACOR") {
      return new Response(JSON.stringify({ error: "empresa inválida. Use OBEN ou COLACOR." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const onlyPending = body?.only_pending === true;
    const esperarCodints: string[] = Array.isArray(body?.esperar_codints)
      ? body.esperar_codints.map((x: unknown) => String(x ?? "").trim()).filter(Boolean) : [];
    if (onlyPending && empresa !== "OBEN") {
      return new Response(JSON.stringify({ error: "only_pending é OBEN-only (fonte única)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { appKey, appSecret } = getOmieCredentials(empresa);
    if (!appKey || !appSecret) throw new Error(`Credenciais Omie ausentes para ${empresa}`);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // 1) SKUs habilitados
    const { data: habilitadosRows, error: habErr } = await supabase
      .from("sku_parametros")
      .select("sku_codigo_omie, sku_descricao")
      .eq("empresa", empresa)
      .eq("habilitado_reposicao_automatica", true);
    if (habErr) throw new Error(`Erro lendo sku_parametros: ${habErr.message}`);

    const habilitados = (habilitadosRows ?? []) as Array<{ sku_codigo_omie: number | string; sku_descricao: string | null }>;
    const habilitadoMap = new Map<string, string | null>();
    for (const r of habilitados) habilitadoMap.set(String(r.sku_codigo_omie), r.sku_descricao ?? null);
    const habilitadoSet = new Set(habilitadoMap.keys());
    const totalEsperado = habilitadoMap.size;
    console.log(`[omie-sync-estoque] ${empresa}: ${totalEsperado} SKUs habilitados (onlyPending=${onlyPending}).`);

    if (totalEsperado === 0) {
      return new Response(JSON.stringify({ ok: true, empresa, total_skus_esperados: 0, mensagem: "Nenhum SKU habilitado." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2) FÍSICO (ListarPosEstoque) — só no full (only_pending NÃO atualiza frescor do físico).
    const encontrados = new Map<string, { fisico: number; reservado: number; locais: number }>();
    let totalRegistros = 0;
    let paginasFisico = 0;
    if (!onlyPending) {
      const dataPosicao = ddmmyyyy(new Date());
      let page = 1, totalPaginas = 1;
      do {
        const resp = await callOmie<OmiePosEstoqueResponse>(
          appKey, appSecret, "ListarPosEstoque",
          { nPagina: page, nRegPorPagina: PAGE_SIZE, dDataPosicao: dataPosicao, cExibeTodos: "S" },
        );
        totalPaginas = resp.nTotPaginas ?? 1;
        totalRegistros = resp.nTotRegistros ?? totalRegistros;
        for (const item of resp.produtos ?? []) {
          const codigo = String(item.nCodProd ?? "").trim();
          if (!codigo || !habilitadoMap.has(codigo)) continue;
          const acc = encontrados.get(codigo) ?? { fisico: 0, reservado: 0, locais: 0 };
          acc.fisico += Number(item.fisico ?? 0);
          acc.reservado += Number(item.reservado ?? 0);
          acc.locais += 1;
          encontrados.set(codigo, acc);
        }
        paginasFisico = page;
        page++;
      } while (page <= totalPaginas);
      console.log(`[omie-sync-estoque] físico: ${totalRegistros} no Omie, ${encontrados.size}/${totalEsperado} habilitados encontrados.`);
    }

    // 3) "A CAMINHO"
    let coleta: OnOrderColeta | null = null;
    let pendenteColacor: Map<string, number> | null = null;

    if (empresa === "OBEN") {
      // FONTE ÚNICA. Com esperar_codints, re-varre até ver os AFI-<id> recém-disparados (poucos s).
      coleta = await coletarOnOrder(appKey, appSecret, habilitadoSet);
      if (esperarCodints.length) {
        let tent = 1;
        while (codintsFaltantes(esperarCodints, coleta.codints).length > 0 && tent < ESPERA_CODINTS_TENTATIVAS) {
          await new Promise((r) => setTimeout(r, ESPERA_CODINTS_BACKOFF_MS));
          coleta = await coletarOnOrder(appKey, appSecret, habilitadoSet);
          tent++;
        }
        const faltam = codintsFaltantes(esperarCodints, coleta.codints);
        if (faltam.length) {
          // NÃO-fatal: aplica o que viu; a barreira fail-closed do motor (passo 3) cobre o AFI-<id> ausente.
          console.warn(`[omie-sync-estoque] esperar_codints: faltam ${faltam.join(",")} após ${tent} tentativas — aplica mesmo assim (barreira do motor cobre).`);
        }
      }
      if (coleta.problemas.length) {
        // FAIL-CLOSED: não aplica nada (mantém o snapshot anterior). A sync falha → o Sentinela pega.
        throw new Error(`on-order fail-closed: ${coleta.problemas.length} problema(s): ${coleta.problemas.slice(0, 5).join(" | ")}`);
      }
    } else {
      // COLACOR: ListarSaldoPendente (não-objetivo v1; mantém o caminho legado).
      try {
        pendenteColacor = await computePendenteViaSaldoPendente(appKey, appSecret, habilitadoMap);
      } catch (err) {
        console.warn(`[omie-sync-estoque] COLACOR ListarSaldoPendente falhou (não-fatal): ${err instanceof Error ? err.message : String(err)}`);
        pendenteColacor = new Map();
      }
    }

    const runId = Date.now();              // epoch-ms do FIM da varredura — monotônico (run velho não sobrescreve)
    const observedAt = new Date().toISOString();

    // 4) GRAVAÇÃO
    let sincronizados = 0;
    const errosUpsert: Array<{ sku: string; erro: string }> = [];
    const naoEncontrados: string[] = [];

    if (!onlyPending) {
      // Upsert do FÍSICO. OBEN: SEM estoque_pendente_entrada (a RPC é dona da coluna — D1).
      //                 COLACOR: COM estoque_pendente_entrada (ListarSaldoPendente, legado).
      const upsertRows = Array.from(encontrados.entries()).map(([codigo, agg]) => {
        const base: Record<string, unknown> = {
          empresa,
          sku_codigo_omie: codigo,
          estoque_fisico: agg.fisico,
          estoque_disponivel: agg.fisico - agg.reservado,
          ultima_sincronizacao: observedAt,
          fonte_sync: agg.locais > 1 ? `ListarPosEstoque(${agg.locais} locais)` : "ListarPosEstoque",
        };
        if (empresa === "COLACOR") base.estoque_pendente_entrada = pendenteColacor?.get(codigo) ?? 0;
        return base;
      });

      const CHUNK = 200;
      for (let i = 0; i < upsertRows.length; i += CHUNK) {
        const slice = upsertRows.slice(i, i + CHUNK);
        const { error } = await supabase.from("sku_estoque_atual").upsert(slice, { onConflict: "empresa,sku_codigo_omie" });
        if (error) {
          for (const row of slice) {
            const { error: e2 } = await supabase.from("sku_estoque_atual").upsert(row, { onConflict: "empresa,sku_codigo_omie" });
            if (e2) errosUpsert.push({ sku: String(row.sku_codigo_omie), erro: e2.message });
            else sincronizados++;
          }
        } else {
          sincronizados += slice.length;
        }
      }

      // SKUs habilitados que não vieram do Omie → marca inativo + alerta (igual ao legado).
      for (const codigo of habilitadoMap.keys()) if (!encontrados.has(codigo)) naoEncontrados.push(codigo);
      if (naoEncontrados.length > 0) {
        console.warn(`[omie-sync-estoque] ${naoEncontrados.length} SKUs habilitados não vieram do Omie.`);
        const { data: existentes } = await supabase.from("sku_status_omie")
          .select("sku_codigo_omie, data_inativacao").eq("empresa", empresa).in("sku_codigo_omie", naoEncontrados);
        const existentesMap = new Map((existentes ?? []).map((r) => [r.sku_codigo_omie, r.data_inativacao]));
        const enrichedStatus = naoEncontrados.map((codigo) => ({
          empresa, sku_codigo_omie: codigo, sku_descricao: habilitadoMap.get(codigo) ?? null,
          ativo_no_omie: false, ultima_sincronizacao: observedAt,
          fonte_sincronizacao: "nao_apareceu_em_ListarPosicaoEstoque",
          data_inativacao: existentesMap.get(codigo) ?? observedAt,
        }));
        const { error: statusErr } = await supabase.from("sku_status_omie").upsert(enrichedStatus, { onConflict: "empresa,sku_codigo_omie" });
        if (statusErr) console.error(`[omie-sync-estoque] erro upsert sku_status_omie: ${statusErr.message}`);

        const { data: eventosExistentes } = await supabase.from("eventos_outlier")
          .select("sku_codigo_omie").eq("empresa", empresa).eq("tipo", "sku_inativado_omie").eq("status", "pendente").in("sku_codigo_omie", naoEncontrados);
        const jaTemEvento = new Set((eventosExistentes ?? []).map((e) => e.sku_codigo_omie));
        const novosEventos = naoEncontrados.filter((c) => !jaTemEvento.has(c)).map((codigo) => ({
          empresa, sku_codigo_omie: codigo, sku_descricao: habilitadoMap.get(codigo) ?? null,
          tipo: "sku_inativado_omie", severidade: "atencao", data_evento: observedAt.slice(0, 10),
          detalhes: { mensagem: "SKU foi inativado no Omie.", detectado_em: observedAt, fonte: "omie-sync-estoque" },
        }));
        if (novosEventos.length > 0) {
          const { error: evErr } = await supabase.from("eventos_outlier").insert(novosEventos);
          if (evErr) console.error(`[omie-sync-estoque] erro inserindo eventos_outlier: ${evErr.message}`);
        }
      }

      // Marcador de frescor do FÍSICO (Sentinela passo 5 lê o marcador, não o max(ultima_sincronizacao)).
      const { error: mkErr } = await supabase.from("sync_state").upsert({
        entity_type: "reposicao_estoque_full",
        account: empresa.toLowerCase(),
        status: "complete",
        last_sync_at: observedAt,
        total_synced: sincronizados,
        metadata: { run_id: runId, paginas: paginasFisico, total_omie: totalRegistros, nao_encontrados: naoEncontrados.length },
        updated_at: observedAt,
      }, { onConflict: "entity_type,account" });
      if (mkErr) console.error(`[omie-sync-estoque] erro marcador reposicao_estoque_full: ${mkErr.message}`);
    }

    // "A caminho" — OBEN via RPC atômica; COLACOR já foi gravado no upsert do físico.
    let rpcResult: unknown = null;
    if (empresa === "OBEN" && coleta) {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("aplicar_snapshot_pendente", {
        p_empresa: "OBEN",
        p_pendente: coleta.porSku,
        p_codints_aprovados: coleta.codints,
        p_run_id: runId,
        p_observed_at: observedAt,
        p_meta: {
          empty_page_reached: "true",
          paginas: coleta.paginasLidas,
          pedidos_vistos: coleta.pedidosVistos,
          etapas_vistas: coleta.etapasVistas,
          modo: onlyPending ? "only_pending" : "full",
          esperar_codints: esperarCodints.length || undefined,
        },
      });
      if (rpcErr) throw new Error(`aplicar_snapshot_pendente: ${rpcErr.message}`);
      rpcResult = rpcData;
    }

    const summary = {
      ok: true,
      empresa,
      modo: onlyPending ? "only_pending" : "full",
      sync_iniciado_em: startedAt.toISOString(),
      sync_concluido_em: new Date().toISOString(),
      duracao_ms: Math.round(performance.now() - t0),
      total_skus_esperados: totalEsperado,
      sincronizados,
      nao_encontrados: naoEncontrados.length,
      erros_upsert: errosUpsert.length,
      paginas_fisico: paginasFisico,
      on_order: coleta
        ? { skus_com_pendente: Object.keys(coleta.porSku).length, codints: coleta.codints.length, paginas: coleta.paginasLidas, pedidos_vistos: coleta.pedidosVistos, etapas_vistas: coleta.etapasVistas, rpc: rpcResult }
        : { colacor_saldo_pendente: pendenteColacor?.size ?? 0 },
      run_id: runId,
      lista_erros: errosUpsert,
    };
    console.log("[omie-sync-estoque] resumo:", JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.startsWith("AUTH_ERROR");
    console.error(`[omie-sync-estoque] ${isAuth ? "CRÍTICO AUTH" : "ERRO"}: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: msg, critical: isAuth, duracao_ms: Math.round(performance.now() - t0) }),
      { status: isAuth ? 401 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
