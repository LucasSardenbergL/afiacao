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

import { createClient } from "npm:@supabase/supabase-js@2";
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
// [perf 2026-06-13] 50→200: o full sync varre TODAS as POs abertas de OBEN (acúmulo desde 2010) até a página
// vazia, com 1,1s de sleep/página → a 50/página estourava o wall-clock do edge (~400s) e morria sem escrever o
// snapshot (marker preso em 'syncing'). 200/página = 4× menos páginas → 4× menos sleeps. PURA PERF: mesmas POs,
// zero mudança de semântica (derivação/de-dup/etapa-filtro independem do tamanho da página; o físico já usa 500).
const PEDIDOS_REGS_POR_PAGINA = 200;
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
// [P2 round6/7] parse estrito: number finito; string SÓ decimal (regex; rejeita ""/" "/hex/científico); resto→NaN.
function parseQtd(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
// [P1 round7] recebido: AUSENTE (undefined) = nada recebido → 0; null/inválido → NaN → flag (null num parcialmente
// recebido contaria saldo cheio = ruptura).
function parseRecebido(v: unknown): number {
  return v === undefined ? 0 : parseQtd(v);
}
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
interface OmiePedItemRaw { nCodProd?: number | string; nQtde?: number | null; nQtdeRec?: number | null; [k: string]: unknown; }
interface OmiePedCabRaw { nCodPed?: number | string; cNumero?: number | string; cCodIntPed?: string; cEtapa?: string; [k: string]: unknown; }
interface OmiePedConsultaRaw { cabecalho_consulta?: OmiePedCabRaw; cabecalho?: OmiePedCabRaw; produtos_consulta?: OmiePedItemRaw[]; [k: string]: unknown; }
interface ColetaPaginaOpts { etapasAprovadas: ReadonlySet<string>; etapasEmAprovacao?: ReadonlySet<string>; skusHabilitados?: ReadonlySet<string>; }
interface ColetaPaginaResult { items: PoItemOmie[]; codintsAprovados: string[]; codintsEmAprovacao: string[]; pedidosVistos: number; etapasVistas: string[]; numerosVistos: string[]; problemas: string[]; }
function norm(v: unknown): string { return String(v ?? "").trim(); }
function coletarDaPagina(pedidos: readonly OmiePedConsultaRaw[] | undefined, opts: ColetaPaginaOpts): ColetaPaginaResult {
  const items: PoItemOmie[] = [];
  const codintsAprovados: string[] = [];
  const codintsEmAprovacao: string[] = [];
  const etapasVistas = new Set<string>();
  const numerosVistos: string[] = [];
  const problemas: string[] = [];
  const lista = pedidos ?? [];
  for (const ped of lista) {
    const cab = ped?.cabecalho_consulta ?? ped?.cabecalho ?? {};
    const etapa = norm(cab.cEtapa);
    const cNumero = norm(cab.cNumero);
    const cCodIntPed = norm(cab.cCodIntPed);
    if (etapa) etapasVistas.add(etapa);
    // [P1 round8/9/10] de-dup precisa de chave CANÔNICA presente em TODA aparição da PO. "id OU numero" (round9)
    // deixava escapar omissões complementares ({id:A} numa pág vs {numero:N} noutra, mesma PO → chaves disjuntas
    // → soma dupla → overcount → ruptura, Codex round10). EXIGIR nCodPed (PK interno do Omie) em TODA PO →
    // `id:<nCodPed>` compartilhado; sem nCodPed → fail-closed (halt > overcount). cNumero = alias secundário.
    const nCodPed = norm(cab.nCodPed);
    if (!nCodPed) {
      problemas.push(`PO sem nCodPed (ID interno) — sem chave canônica p/ de-dup entre páginas → fail-closed (etapa=${etapa}, cNumero=${cNumero || "—"})`);
    } else {
      numerosVistos.push(`id:${nCodPed}`);
      if (cNumero) numerosVistos.push(`numero:${cNumero}`);
    }
    // [novo furo Codex] etapa que CONTA o saldo (não em-aprovação) com item SEM nCodProd e saldo>0 → fail-closed.
    const etapaConta = !opts.etapasEmAprovacao?.has(etapa);
    let itensComSku = 0;
    let itemSemSkuComSaldo = false;
    for (const it of ped?.produtos_consulta ?? []) {
      const sku = norm(it.nCodProd);
      if (!sku) {
        // [P2 round4/5/6/7] sem nCodProd em etapa que conta: anômalo se qty/recebido INVÁLIDA OU saldo>0.
        // parseQtd estrito; parseRecebido (r: SÓ undefined→0, null→NaN→flag).
        if (etapaConta) {
          const q = parseQtd(it.nQtde), r = parseRecebido(it.nQtdeRec);
          if (!quantidadesValidas(q, r) || (q - r) > 0) itemSemSkuComSaldo = true;
        }
        continue;
      }
      itensComSku++;
      if (opts.skusHabilitados && !opts.skusHabilitados.has(sku)) continue;
      // [P1-E/round6/7] qtde via parseQtd (ausente/null/inválida→NaN→problema→abort); recebido via parseRecebido
      // (undefined=nada recebido→0; null/""→NaN→flag — null num parcialmente recebido contaria saldo cheio=ruptura).
      items.push({ sku, poNumero: cNumero, etapa, qtde: parseQtd(it.nQtde), recebido: parseRecebido(it.nQtdeRec) });
    }
    // [novo furo] item sem nCodProd com saldo numa etapa que conta → saldo omitido → fail-closed.
    if (etapaConta && itemSemSkuComSaldo) {
      problemas.push(`PO com item SEM nCodProd e saldo>0 (po=${cNumero} etapa=${etapa}) — saldo seria omitido`);
    }
    if (opts.etapasAprovadas.has(etapa)) {
      // [P1.1] PO aprovada sem item com SKU = resposta suspeita → fail-closed; codint NÃO entra.
      if (itensComSku === 0) {
        problemas.push(`PO aprovada sem item com SKU (po=${cNumero} codint=${cCodIntPed || "manual"})`);
      } else if (cCodIntPed) {
        codintsAprovados.push(cCodIntPed);
      }
    } else if (opts.etapasEmAprovacao?.has(etapa) && cCodIntPed) {
      // [P1.2] PO do app em aprovação → barreira (3b) aborta enquanto não virar etapa-15.
      codintsEmAprovacao.push(cCodIntPed);
    }
  }
  return { items, codintsAprovados, codintsEmAprovacao, pedidosVistos: lista.length, etapasVistas: [...etapasVistas], numerosVistos, problemas };
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
interface VarrerPedidosOpts { etapasAprovadas: ReadonlySet<string>; etapasEmAprovacao?: ReadonlySet<string>; skusHabilitados?: ReadonlySet<string>; maxPaginas: number; }
interface VarrerPedidosResult { items: PoItemOmie[]; codintsAprovados: string[]; codintsEmAprovacao: string[]; etapasVistas: string[]; pedidosVistos: number; paginasLidas: number; problemas: string[]; }
// [P1-D] verbos genéricos REMOVIDOS. [P2-D] `\b` após `h[áa]` falhava (á não é \w no JS) → exige "registros"
// ADJACENTE ao verbo (`\s+registros`, sem `.{0,30}` que abria over-match em "Não há permissão ... registros" =
// ERRO). Espelho VERBATIM de src/lib/reposicao/pendente-entrada-po.ts.
const FIM_SEM_REGISTROS =
  /(\bsem\s+registros?\b|\bnenhum\s+registros?\b|n[ãa]o\s+(existem?|h[áa])\s+registros?\b|n[ãa]o\s+foram\s+encontrad\w*\s+registros?\b|\bregistros?\s+n[ãa]o\s+(existem?|foram\s+encontrad\w*|encontrad\w*)\b)/i;
async function varrerPedidos(
  fetchPagina: (pagina: number) => Promise<PaginaPedidos>,
  opts: VarrerPedidosOpts,
): Promise<VarrerPedidosResult> {
  const items: PoItemOmie[] = [];
  const codintsAprovados = new Set<string>();
  const codintsEmAprovacao = new Set<string>();
  const etapas = new Set<string>();
  const problemas: string[] = [];
  let pedidosVistos = 0;
  let paginasLidas = 0;
  const fpsVistos = new Set<string>(); // [P1.7] todos os fps vistos (pega repetição não-consecutiva A/B/A)
  const numerosGlobais = new Set<string>(); // [P1 round7/10] identidade de PO (id:<nCodPed> canônico + numero: secundário) vista globalmente — pega sobreposição entre páginas
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
    if (fp !== "" && fpsVistos.has(fp)) {
      throw new Error(`PesquisarPedCompra REPETIÇÃO de página (pág ${pagina} fp=${fp} já vista) — abortando p/ não overcount/double-buy`);
    }
    fpsVistos.add(fp);
    paginasLidas++;
    const c = coletarDaPagina(pedidos, { etapasAprovadas: opts.etapasAprovadas, etapasEmAprovacao: opts.etapasEmAprovacao, skusHabilitados: opts.skusHabilitados });
    for (const alias of c.numerosVistos) { // [P1 round7/9] PO (qualquer alias) repetida entre páginas → FATAL (shift)
      if (numerosGlobais.has(alias)) throw new Error(`PesquisarPedCompra PO REPETIDA entre páginas (identidade ${alias} na pág ${pagina} já vista) — abortando p/ não overcount/double-buy`);
      numerosGlobais.add(alias);
    }
    for (const it of c.items) items.push(it);
    for (const cc of c.codintsAprovados) codintsAprovados.add(cc);
    for (const cc of c.codintsEmAprovacao) codintsEmAprovacao.add(cc);
    for (const e of c.etapasVistas) etapas.add(e);
    for (const p of c.problemas) problemas.push(p);
    pedidosVistos += c.pedidosVistos;
  }
  if (!fim) throw new Error(`PesquisarPedCompra excedeu ${opts.maxPaginas} páginas sem ver fim — abortando (anti-truncamento)`);
  return { items, codintsAprovados: [...codintsAprovados], codintsEmAprovacao: [...codintsEmAprovacao], etapasVistas: [...etapas], pedidosVistos, paginasLidas, problemas };
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
  codintsEmAprovacao: string[];
  problemas: string[];
  paginasLidas: number;
  pedidosVistos: number;
  etapasVistas: string[];
  /** [P1.3] epoch-ms do INÍCIO desta varredura (run_id causal: quem começou a observar depois é o mais novo). */
  runId: number;
  observedAt: string;
}

// Varre TODAS as POs abertas (varrerPedidos: paginar até página vazia + anti-loop + teto fatal) e deriva
// o "a caminho" por SKU via computeOnOrder. O fetchPagina injetado faz callOmiePedidos + sleep de rate-limit.
// problemas != [] (coleta P1.1 + derivação computeOnOrder) NÃO é fatal aqui — volta no resultado p/ o caller
// abortar o apply (mantendo o snapshot).
async function coletarOnOrder(
  appKey: string, appSecret: string, habilitadoSet: ReadonlySet<string>,
): Promise<OnOrderColeta> {
  const runId = Date.now();                       // [P1.3] run_id = INÍCIO da varredura (antes de paginar)
  const observedAt = new Date(runId).toISOString();
  let primeira = true;
  const fetchPagina = async (pagina: number): Promise<PaginaPedidos> => {
    if (!primeira) await new Promise((r) => setTimeout(r, 1100)); // rate-limit do Omie entre páginas
    primeira = false;
    const resp = await callOmiePedidos(appKey, appSecret, pagina);
    return { pedidos: resp.pedidos_pesquisa, faultstring: resp.faultstring };
  };
  const v = await varrerPedidos(fetchPagina, {
    etapasAprovadas: ETAPAS_APROVADO_ABERTO, etapasEmAprovacao: ETAPAS_IGNORADAS,
    skusHabilitados: habilitadoSet, maxPaginas: PEDIDOS_MAX_PAGINAS,
  });
  const { porSku, problemas: problemasDerivacao } = computeOnOrder(v.items, {
    etapasAprovadas: ETAPAS_APROVADO_ABERTO, etapasIgnoradas: ETAPAS_IGNORADAS,
  });
  const porSkuObj: Record<string, number> = {};
  for (const [k, val] of porSku) porSkuObj[k] = val;
  return {
    porSku: porSkuObj, codints: v.codintsAprovados, codintsEmAprovacao: v.codintsEmAprovacao,
    problemas: [...v.problemas, ...problemasDerivacao], // [P1.1] coleta + [helper] derivação
    paginasLidas: v.paginasLidas, pedidosVistos: v.pedidosVistos, etapasVistas: v.etapasVistas,
    runId, observedAt,
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

// Lê o físico (ListarPosEstoque) paginado e agrega por SKU habilitado. [round6] Chamado UMA vez (físico-first;
// o "bracket" de 2ª leitura foi removido — ver o bloco-doc abaixo). A agregação Σ por locais pode ter poeira
// de soma-float, mas isso não é mais comparado (sem bracket).
async function lerFisicoOmie(
  appKey: string, appSecret: string, habilitadoMap: Map<string, string | null>,
): Promise<{ map: Map<string, { fisico: number; reservado: number; locais: number }>; totalRegistros: number; paginas: number }> {
  const map = new Map<string, { fisico: number; reservado: number; locais: number }>();
  const dataPosicao = ddmmyyyy(new Date());
  let page = 1, totalPaginas = 1, totalRegistros = 0, paginas = 0;
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
      const acc = map.get(codigo) ?? { fisico: 0, reservado: 0, locais: 0 };
      acc.fisico += Number(item.fisico ?? 0);
      acc.reservado += Number(item.reservado ?? 0);
      acc.locais += 1;
      map.set(codigo, acc);
    }
    paginas = page;
    page++;
  } while (page <= totalPaginas);
  return { map, totalRegistros, paginas };
}

// [P1-B round5] O "bracket" (re-ler físico T3 e abortar no AUMENTO) foi REMOVIDO — era over-engineering que
// PIOROU a coisa: ao gravar o físico T3 (mais NOVO que o saldo lido em T2), criou skew na direção RUPTURA, e a
// detecção por aumento de físico era furada (uma VENDA concorrente mascara o recebimento — Δfísico líquido 0 →
// não abortava → grava saldo stale-alto → overcount → ruptura; Codex round5). Decisão: voltar ao FÍSICO-FIRST e
// gravar o físico da PRIMEIRA leitura (T1, ANTES da varredura das POs). Aí o skew físico×a-caminho é SEMPRE a
// direção SEGURA: um recebimento em [T1,T2] → físico-T1 (não tem os bens) + saldo-T2 (já reduzido) → SUBcount →
// supercompra (nunca ruptura); um recebimento DEPOIS de T2 → físico-T1 + saldo-alto = correto (em trânsito). A
// staleness por VENDA (físico-T1 vira stale-alto) NÃO é o skew de recebimento — é a idade-de-snapshot inerente a
// QUALQUER motor (o físico já é minutos-velho na hora do motor); aceita, igual ao P1-F. Snapshot atômico físico+
// saldo o Omie não dá → o skew é inevitável; físico-first garante que ele caia no lado supercompra.
// ⚠️ RESIDUAL INERENTE (Codex round6, P1 sem fix client-side): o físico-first é seguro SOB consistência causal dos
//   2 endpoints do Omie. Se o ListarPosEstoque (físico) JÁ enxergar um recebimento mas o PesquisarPedCompra
//   POSTERIOR ainda devolver o nQtdeRec ANTIGO (lag/cache interno entre os subsistemas do Omie), grava físico-novo
//   + saldo-velho → overcount → ruptura. NENHUMA ordem de leitura nem snapshot do nosso lado conserta (é a
//   consistência INTERNA do Omie). Mitigantes: (a) um recebimento no Omie atualiza estoque E a OS no MESMO
//   recebimento (provável commit conjunto → janela ~0); (b) se houver lag, exige que ele seja > a duração do sync
//   (~10-30s) E que o físico vá na frente da OS — improvável; (c) bounded (1 SKU) + auto-corrige no próximo sync.
//   Aceito como limitação da API do Omie (decisão founder), igual ao P1-F. O bracket NÃO resolvia isto (o recebido
//   já estava no físico em T1 → T3 igual → sem aborto) e ainda criava ruptura por máscara de venda — por isso fora.

// [P1-A round3] A gravação do marcador de frescor do FÍSICO virou 2 RPCs SQL-puras com lock/ownership:
//   • claim_estoque_full_sync  — reivindica 'syncing' ATOMICAMENTE no início (substitui o guard TOCTOU).
//   • finalizar_estoque_full_sync — grava 'complete'/'error' SÓ se ESTE run ainda é dono do claim (run_id),
//     senão (claim roubado (TTL 15min > teto da plataforma)) NÃO finaliza → o motor não lê físico-de-A + a-caminho-de-B.
// 'syncing' no início + 'complete'/'error' só no fim do MESMO run dono = par atômico p/ o motor (barreira 4b).

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

    // [P1-A] CLAIM ATÔMICO do full sync (substitui a guarda TOCTOU + o marcarFullSync('syncing') inicial). A RPC
    // claim_estoque_full_sync grava status='syncing' SE livre (não-'syncing' OU 'syncing' velho >15min), numa única
    // instrução com lock de linha → SÓ um concorrente reivindica (cron×manual). false = outro full sync recente em
    // andamento → PULA. Bloqueia o motor (barreira 4b: status<>'complete') durante TODA a janela de escrita; só vira
    // 'complete'/'error' no FIM (par físico+a-caminho atômico do ponto de vista do motor). 'syncing' preso (sync que
    // morreu) auto-liberta após 15min. only_pending (bump) NÃO reivindica nem toca o full marker.
    const fullRunId = Date.now();
    const syncStartIso = new Date(fullRunId).toISOString();
    if (!onlyPending) {
      const { data: claimed, error: claimErr } = await supabase.rpc("claim_estoque_full_sync", {
        p_account: empresa.toLowerCase(), p_run_id: fullRunId, p_at: syncStartIso,
      });
      if (claimErr) throw new Error(`claim_estoque_full_sync: ${claimErr.message}`);
      if (claimed !== true) {
        console.log(`[omie-sync-estoque] ${empresa}: full sync já em andamento (claim negado) — pulando.`);
        return new Response(JSON.stringify({ ok: true, empresa, skipped: "full sync já em andamento (claim negado)" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // 2) FÍSICO (ListarPosEstoque) — só no full (only_pending NÃO atualiza frescor do físico). [P1-B] leitura T1.
    let encontrados = new Map<string, { fisico: number; reservado: number; locais: number }>();
    let totalRegistros = 0;
    let paginasFisico = 0;
    if (!onlyPending) {
      const r1 = await lerFisicoOmie(appKey, appSecret, habilitadoMap);
      encontrados = r1.map; totalRegistros = r1.totalRegistros; paginasFisico = r1.paginas;
      console.log(`[omie-sync-estoque] físico T1: ${totalRegistros} no Omie, ${encontrados.size}/${totalEsperado} habilitados encontrados.`);
    }

    // 3) "A CAMINHO"
    let coleta: OnOrderColeta | null = null;
    let pendenteColacor: Map<string, number> | null = null;

    if (empresa === "OBEN") {
      // FONTE ÚNICA. Com esperar_codints, re-varre até ver os AFI-<id> recém-disparados (poucos s).
      coleta = await coletarOnOrder(appKey, appSecret, habilitadoSet);
      if (esperarCodints.length) {
        // PO recém-disparada conta como VISTA se aparece em qualquer estado (aprovada OU em aprovação): se está
        // etapa-10, a barreira (3b) já a cobre, então não há por que re-varrer esperando ela virar etapa-15.
        const vistos = (c: OnOrderColeta) => [...c.codints, ...c.codintsEmAprovacao];
        let tent = 1;
        while (codintsFaltantes(esperarCodints, vistos(coleta)).length > 0 && tent < ESPERA_CODINTS_TENTATIVAS) {
          await new Promise((r) => setTimeout(r, ESPERA_CODINTS_BACKOFF_MS));
          coleta = await coletarOnOrder(appKey, appSecret, habilitadoSet);
          tent++;
        }
        const faltam = codintsFaltantes(esperarCodints, vistos(coleta));
        if (faltam.length) {
          // NÃO-fatal: aplica o que viu; a barreira fail-closed do motor (passo 3, cond 3) cobre o AFI-<id> ausente.
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

    // [P1-B round5] SEM bracket: grava o físico da PRIMEIRA leitura (T1, ANTES da varredura das POs). físico-first
    // → o skew físico×a-caminho cai SEMPRE no lado SEGURO (supercompra, nunca ruptura): recebimento em [T1,T2] →
    // físico-T1-baixo + saldo-T2-reduzido → subcount → supercompra; recebimento após T2 → físico-T1 + saldo-alto =
    // correto (em trânsito). A staleness por venda é idade-de-snapshot inerente (aceita). Ver o bloco-doc acima.

    const runId = Date.now();              // timestamp da GRAVAÇÃO do físico (ultima_sincronizacao + marcador final)
    const observedAt = new Date(runId).toISOString(); // [P1.3] a RPC pendente usa coleta.runId/observedAt (início da varredura)

    // 4) GRAVAÇÃO
    let sincronizados = 0;
    const errosUpsert: Array<{ sku: string; erro: string }> = [];
    const naoEncontrados: string[] = [];

    // [P1-A round3] re-checa OWNERSHIP do claim ANTES de escrever o físico: se outro run re-reivindicou o claim,
    // ABORTA aqui (não escreve físico → não mistura linhas com o run que assumiu). Cinto+suspensório do finalize
    // com ownership. [round4] o roubo em si é IMPOSSÍVEL de um sync vivo: o TTL do claim (15min) > o teto de
    // wall-clock do edge function do Supabase (~150-400s) → o runtime mata o sync ANTES do TTL (não depende do cron).
    if (!onlyPending) {
      const { data: dono } = await supabase.from("sync_state")
        .select("status, metadata").eq("entity_type", "reposicao_estoque_full")
        .eq("account", empresa.toLowerCase()).maybeSingle();
      const donoRunId = (dono?.metadata as { run_id?: number } | null)?.run_id;
      if (dono?.status !== "syncing" || donoRunId !== fullRunId) {
        throw new Error(`claim perdido antes da gravação do físico (status=${dono?.status} run=${donoRunId} != ${fullRunId}) — outro sync assumiu; abortando p/ não misturar físico`);
      }
    }

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

      // [P1-A] o marcador 'complete'/'error' do físico NÃO é gravado aqui — vai pro FIM (após o a-caminho do
      // MESMO run), pra o par físico+a-caminho ser atômico do ponto de vista do motor. Aqui o marcador segue 'syncing'.
    }

    // "A caminho" — OBEN via RPC atômica; COLACOR já foi gravado no upsert do físico.
    let rpcResult: unknown = null;
    // [P1-A] pendenteApplied: o a-caminho DESTE run foi de fato gravado? COLACOR grava inline (true). OBEN: a RPC
    // retorna {applied:false, skipped_reason:'stale_run'} se um run MAIS NOVO (ex.: bump only_pending pós-disparo
    // concorrente) já gravou um a-caminho mais recente. Nesse caso o físico DESTE run + o a-caminho do run novo NÃO
    // são um par provadamente coerente → NÃO declaro 'complete' (deixo 'syncing'; o próximo full sync limpo fecha).
    let pendenteApplied = empresa === "COLACOR";
    if (empresa === "OBEN" && coleta) {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("aplicar_snapshot_pendente", {
        p_empresa: "OBEN",
        p_pendente: coleta.porSku,
        p_codints_aprovados: coleta.codints,
        p_codints_em_aprovacao: coleta.codintsEmAprovacao,
        p_run_id: coleta.runId,            // [P1.3] início da varredura (causal)
        p_observed_at: coleta.observedAt,
        p_meta: {
          empty_page_reached: "true",
          paginas: coleta.paginasLidas,
          pedidos_vistos: coleta.pedidosVistos,
          etapas_vistas: coleta.etapasVistas,
          codints_em_aprovacao: coleta.codintsEmAprovacao.length || undefined,
          modo: onlyPending ? "only_pending" : "full",
          esperar_codints: esperarCodints.length || undefined,
        },
      });
      if (rpcErr) throw new Error(`aplicar_snapshot_pendente: ${rpcErr.message}`);
      rpcResult = rpcData;
      pendenteApplied = (rpcData as { applied?: boolean } | null)?.applied === true;
      if (!pendenteApplied) {
        console.warn(`[omie-sync-estoque] aplicar_snapshot_pendente NÃO aplicou (${JSON.stringify(rpcData)}) — run mais novo venceu; deixo o full marker em 'syncing' (próximo sync fecha).`);
      }
    }

    // [P1-A] marcador FINAL do físico = 'complete'/'error', AO FIM (após físico E a-caminho do MESMO run). Só agora
    // o motor (barreira 4b) pode gerar — lendo um par físico+a-caminho coerente do mesmo ciclo. 'error' se o upsert
    // do físico teve falha parcial. [P1-A round3] via finalizar_estoque_full_sync com OWNERSHIP (run_id): se um
    // concorrente roubou o claim (impossível de um sync vivo: TTL 15min > teto de wall-clock da plataforma), o UPDATE casa 0 linhas → finalized=false
    // → NÃO marco 'complete' (não exponho físico-deste-run + a-caminho-de-outro). [P1-A] e só finaliza se o
    // a-caminho deste run foi aplicado (pendenteApplied) — senão deixa 'syncing' p/ o próximo sync limpo.
    if (!onlyPending && pendenteApplied) {
      const fullOk = errosUpsert.length === 0;
      const { data: finalized, error: finErr } = await supabase.rpc("finalizar_estoque_full_sync", {
        p_account: empresa.toLowerCase(),
        p_run_id: fullRunId,
        p_status: fullOk ? "complete" : "error",
        p_at: observedAt,
        p_total_synced: sincronizados,
        p_error_message: fullOk ? null : `${errosUpsert.length} SKU(s) com erro de upsert do físico`,
        p_meta: { paginas: paginasFisico, total_omie: totalRegistros, nao_encontrados: naoEncontrados.length, erros_upsert: errosUpsert.length },
      });
      if (finErr) throw new Error(`finalizar_estoque_full_sync: ${finErr.message}`);
      if (finalized !== true) {
        console.warn(`[omie-sync-estoque] ${empresa}: claim roubado durante o sync (outro run assumiu) — NÃO marco 'complete' (fail-closed).`);
      }
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
