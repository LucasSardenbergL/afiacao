// Edge function: omie-sync-estoque
// Sincroniza estoque físico de SKUs habilitados para reposição automática
// usando o endpoint Omie ListarPosicaoEstoque (1 chamada paginada vs N consultas).
//
// Invocação:
//  - Cron diário 06:00 BRT (09:00 UTC) — agendado via pg_cron
//  - Manual: POST { empresa: "OBEN" }

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders as sharedCors } from "../_shared/auth.ts";

const corsHeaders = {
  ...sharedCors,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/estoque/consulta/";
const PAGE_SIZE = 500;
const MAX_RETRIES = 3;

type Empresa = "OBEN" | "COLACOR";

// Item do método ListarPosEstoque (response.produtos[])
interface OmiePosEstoqueItem {
  nCodProd?: number;
  cCodInt?: string;
  cCodigo?: string;
  cDescricao?: string;
  fisico?: number;
  reservado?: number;
  nPendente?: number; // pendente em pedidos de VENDA (saída), não entrada
  estoque_minimo?: number;
  codigo_local_estoque?: number;
  [k: string]: unknown;
}

interface OmiePosEstoqueResponse {
  nPagina?: number;
  nTotPaginas?: number;
  nRegistros?: number;
  nTotRegistros?: number;
  produtos?: OmiePosEstoqueItem[];
  faultcode?: string;
  faultstring?: string;
}

// Item do método ListarSaldoPendente (response.saldo_pendente_lista[])
interface OmieSaldoPendenteItem {
  id_prod?: number;
  codigo_local_estoque?: number;
  qtde_saida?: number;
  qtde_entrada?: number; // <- pedidos de compra abertos
  [k: string]: unknown;
}

interface OmieSaldoPendenteResponse {
  pagina?: number;
  total_de_paginas?: number;
  registros?: number;
  total_de_registros?: number;
  saldo_pendente_lista?: OmieSaldoPendenteItem[];
  faultcode?: string;
  faultstring?: string;
}

function ddmmyyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function callOmie<T>(
  appKey: string,
  appSecret: string,
  call: string,
  param: Record<string, unknown>,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OMIE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call,
          app_key: appKey,
          app_secret: appSecret,
          param: [param],
        }),
      });

      if (res.status === 429) {
        console.warn(`[omie-sync-estoque] 429 rate limit em ${call}, sleeping 60s`);
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        throw new Error(`AUTH_ERROR ${res.status}: ${body}`);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as T & { faultcode?: string; faultstring?: string };
      if (json.faultcode) {
        throw new Error(`Omie fault ${json.faultcode}: ${json.faultstring}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("AUTH_ERROR")) throw err;
      const wait = 1000 * Math.pow(2, attempt - 1);
      console.warn(
        `[omie-sync-estoque] ${call} attempt ${attempt}/${MAX_RETRIES} falhou: ${msg}. retry em ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error("Falha desconhecida ao chamar Omie");
}

function getOmieCredentials(empresa: Empresa) {
  if (empresa === "OBEN") {
    return {
      appKey: Deno.env.get("OMIE_OBEN_APP_KEY") ?? "",
      appSecret: Deno.env.get("OMIE_OBEN_APP_SECRET") ?? "",
    };
  }
  return {
    appKey: Deno.env.get("OMIE_COLACOR_APP_KEY") ?? "",
    appSecret: Deno.env.get("OMIE_COLACOR_APP_SECRET") ?? "",
  };
}

// ===========================================================================================
// "A caminho" (estoque_pendente_entrada) via PEDIDOS DE COMPRA — OBEN
// ===========================================================================================
// Substitui o ListarSaldoPendente, que é CEGO à previsão FUTURA de PO aprovada (incidente
// 2026-06-11: PO 1054 aprovada, entrega 19/06, FUNDO PU 3un — o motor re-sugeria comprar).
// Lê os pedidos de compra ABERTOS (PesquisarPedCompra), soma (nQtde - nQtdeRec) por SKU sobre os
// APROVADOS (etapa "15" na OBEN), e DE-DUPA contra o que o em_transito da RPC já conta (pedido do
// app disparado/aprovado <7d) — senão a unidade contaria 2× (over-count → sub-compra).
const OMIE_ENDPOINT_PEDIDOS = "https://app.omie.com.br/api/v1/produtos/pedidocompra/";
// [fix entrega-futura 2026-06-26] dDataInicial/dDataFinal do PesquisarPedCompra filtram pela DATA DE
// PREVISÃO DE ENTREGA (dDtPrevisao), NÃO pela data de criação — PROVADO em prod: todo PO entra no espelho
// EXATAMENTE na data da previsão (lag-vs-criação 9–18d, lag-vs-previsão 0 em ~20 POs). Com dDataFinal=hoje,
// TODO pedido com entrega FUTURA (= todo pedido recém-feito dentro do lead time) sumia da resposta →
// estoque_pendente_entrada=0 → o motor RE-SUGERIA comprar o que já fora pedido (incidente PO 1085, entrega
// 08/07, invisível). A janela cobre previsões PASSADAS (atrasados não-recebidos) e FUTURAS (lead time).
// LT OBEN medido: mediana 10d, p95 18d, máx 39d, zero previsões nulas → +120d ≈ 3× o máx (folga).
const PEDIDOS_JANELA_PASSADO_DIAS = 365; // previsão atrasada: PO aberto não-recebido com entrega já vencida
const PEDIDOS_JANELA_FUTURO_DIAS = 120;  // previsão à frente: pedido em trânsito dentro do lead time
const ETAPAS_APROVADO_ABERTO = new Set<string>(["15"]); // OBEN: 15=Aprovado (confirmado 2026-06-11)
const ETAPAS_CONHECIDAS = new Set<string>(["15", "10"]); // 10=Em Aprovação; loga qualquer outra p/ pegar surpresa

interface OmiePedItem { nCodProd?: number | string; nQtde?: number; nQtdeRec?: number; [k: string]: unknown; }
interface OmiePedCab { nCodPed?: number | string; cNumero?: string; cCodIntPed?: string; cEtapa?: string; [k: string]: unknown; }
interface OmiePedConsulta { cabecalho_consulta?: OmiePedCab; cabecalho?: OmiePedCab; produtos_consulta?: OmiePedItem[]; [k: string]: unknown; }
interface OmiePedResponse { pedidos_pesquisa?: OmiePedConsulta[]; nTotalPaginas?: number; faultstring?: string; faultcode?: string; [k: string]: unknown; }

// ── Helper puro (espelho VERBATIM de src/lib/reposicao/pendente-entrada-po.ts; 18 testes vitest) ──
interface PoItemOmie { sku: string; poNumero: string; etapa: string; qtde: number; recebido: number; }
// [Codex P1 2026-06-20] Parse ESTRITO de quantidade (espelho de pendente-entrada-po.ts). Number() mascara dado
// torto: ""/" "/null/false/[]→0, "0x10"→16, "1e3"→1000 — e um nQtdeRec mascarado como 0 conta saldo CHEIO = RUPTURA.
function parseQtd(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
// nQtdeRec AUSENTE (undefined) = nada recebido → 0 (Omie omite); null/""/inválido → NaN (fail-closed, não 0=saldo cheio).
function parseRecebido(v: unknown): number {
  return v === undefined ? 0 : parseQtd(v);
}
function quantidadesValidas(qtde: number, recebido: number): boolean {
  return Number.isFinite(qtde) && Number.isFinite(recebido) && qtde >= 0 && recebido >= 0;
}
function saldoAReceber(qtde: number, recebido: number): number {
  const q = Number.isFinite(qtde) ? qtde : 0;
  const r = Number.isFinite(recebido) ? recebido : 0;
  return Math.max(0, q - r);
}
function itemContaComoPendente(
  item: PoItemOmie,
  opts: { etapasAbertas: ReadonlySet<string>; poNumerosEmTransito: ReadonlySet<string> },
): boolean {
  if (!opts.etapasAbertas.has(item.etapa)) return false;
  if (opts.poNumerosEmTransito.has(item.poNumero)) return false;
  return saldoAReceber(item.qtde, item.recebido) > 0;
}
function computePendenteEntradaPorSku(
  items: readonly PoItemOmie[],
  opts: { etapasAbertas: ReadonlySet<string>; poNumerosEmTransito: ReadonlySet<string> },
): Map<string, number> {
  const porSku = new Map<string, number>();
  for (const item of items) {
    if (!itemContaComoPendente(item, opts)) continue;
    const add = saldoAReceber(item.qtde, item.recebido);
    porSku.set(item.sku, (porSku.get(item.sku) ?? 0) + add);
  }
  return porSku;
}

function ddmmyyyyPed(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function callOmiePedidos(
  appKey: string, appSecret: string, pagina: number, dataDe: string, dataAte: string,
): Promise<OmiePedResponse> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(OMIE_ENDPOINT_PEDIDOS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call: "PesquisarPedCompra",
        app_key: appKey,
        app_secret: appSecret,
        // Inclui todos os estados potencialmente ABERTOS; exclui o que claramente fechou.
        // (o filtro fino de aprovado/saldo é em memória, robusto à incerteza do nome do flag).
        param: [{
          nPagina: pagina,
          nRegsPorPagina: 100, // MÁXIMO do PesquisarPedCompra — o Omie rejeita >100 (HTTP 500 "valor máximo de registros por página é [100]"); 100 > 50 da edge antiga → ainda corta as páginas pela metade
          lApenasImportadoApi: "F",
          lExibirPedidosPendentes: "T",
          lExibirPedidosFaturados: "T",
          lExibirPedidosRecParciais: "T",
          lExibirPedidosFatParciais: "T",
          lExibirPedidosRecebidos: "F",
          lExibirPedidosCancelados: "F",
          lExibirPedidosEncerrados: "F",
          dDataInicial: dataDe,
          dDataFinal: dataAte,
        }],
      }),
    });
    const text = await res.text();
    let json: OmiePedResponse;
    try { json = JSON.parse(text) as OmiePedResponse; } catch { json = {} as OmiePedResponse; }
    if (res.status === 429 || (json?.faultstring && /rate limit/i.test(json.faultstring))) {
      console.warn(`[omie-sync-estoque] PesquisarPedCompra 429 (tentativa ${attempt}/${MAX_RETRIES}), aguardando 5s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    // [fix 2026-06-23] O Omie sinaliza FIM DE PÁGINAS com HTTP 500 + faultstring "Não existem registros para a
    // página [N]" (faultcode 5113), NÃO com 200+lista-vazia. Sem isto, o throw em !res.ok matava a paginação-até-
    // vazia na 1ª página-além-do-fim → sync abortava (fail-closed, mas nunca completava). Devolve o json p/ o loop
    // tratar como fim via FIM_SEM_REGISTROS (conservadora — só o "fim" casa; erro real do Omie ainda lança abaixo).
    if (!res.ok && json?.faultstring && FIM_SEM_REGISTROS.test(json.faultstring)) return json;
    if (!res.ok) throw new Error(`PesquisarPedCompra HTTP ${res.status}: ${text.slice(0, 300)}`);
    return json;
  }
  throw new Error("PesquisarPedCompra: rate limit excedido");
}

// Chaves do em_transito da RPC (anti double-count): pedido_compra_sugerido OBEN disparado/aprovado <7d.
// O mesmo predicado da CTE em_transito (1º ramo). De-dup por cNumero (=omie_pedido_compra_numero) E por
// cCodIntPed=AFI-<id> (carimbo do disparo, robusto caso o numero não tenha voltado do Omie).
async function fetchEmTransitoKeys(
  supabase: SupabaseClient,
): Promise<{ numeros: Set<string>; codInts: Set<string> }> {
  const numeros = new Set<string>();
  const codInts = new Set<string>();
  const corte = new Date();
  corte.setDate(corte.getDate() - 7);
  const { data, error } = await supabase
    .from("pedido_compra_sugerido")
    .select("id, omie_pedido_compra_numero")
    .eq("empresa", "OBEN")
    .in("status", ["aprovado_aguardando_disparo", "disparado", "concluido_recebido"])
    .gte("data_ciclo", corte.toISOString().slice(0, 10));
  if (error) throw new Error(`em_transito query: ${error.message}`);
  for (const r of (data ?? []) as Array<{ id: string; omie_pedido_compra_numero: string | null }>) {
    if (r.omie_pedido_compra_numero) numeros.add(String(r.omie_pedido_compra_numero).trim());
    codInts.add(`AFI-${r.id}`);
  }
  return { numeros, codInts };
}

// ── Paginação ATÉ PÁGINA VAZIA (espelho das primitivas testadas do helper) ───────────────────────
// O nTotalPaginas do Omie SUB-REPORTA em listas grandes (bug conhecido, já mordeu CR/CP no financeiro):
// confiar nele lê só a 1ª página → POs aprovadas além dela somem → estoque_pendente_entrada subestimado
// → o motor re-sugere comprar = DOUBLE-BUY. Paginar até a página vazia + fingerprint anti-loop + de-dup
// de PO por nCodPed entre páginas + teto técnico fatal (espelho de pendente-entrada-po.ts, 9 rounds Codex).
const MAX_PAGINAS_PED = 200; // teto técnico FATAL anti-loop (a janela ~485d de POs ABERTOS cabe MUITO abaixo disso)
// fault do Omie que significa "fim legítimo" (sem registros), NÃO erro. Conservadora: exige "registro(s)"
// ADJACENTE a uma negação de EXISTÊNCIA (a fault canônica é "Não existem registros para a página informada").
// Espelho VERBATIM de pendente-entrada-po.ts:FIM_SEM_REGISTROS (endurecido por Codex P1.7/P1-D/P2-D).
const FIM_SEM_REGISTROS =
  /(\bsem\s+registros?\b|\bnenhum\s+registros?\b|n[ãa]o\s+(existem?|h[áa])\s+registros?\b|n[ãa]o\s+foram\s+encontrad\w*\s+registros?\b|\bregistros?\s+n[ãa]o\s+(existem?|foram\s+encontrad\w*|encontrad\w*)\b)/i;
// fingerprint barato de página (anti-loop): mesma página não-vazia repetida = Omie em loop → abort FATAL.
function fingerprintPagina(pedidos: readonly OmiePedConsulta[]): string {
  if (!pedidos || pedidos.length === 0) return "";
  const prim = pedidos[0]?.cabecalho_consulta ?? pedidos[0]?.cabecalho ?? {};
  const ult = pedidos[pedidos.length - 1]?.cabecalho_consulta ?? pedidos[pedidos.length - 1]?.cabecalho ?? {};
  return `${pedidos.length}:${String(prim?.cNumero ?? "").trim()}:${String(ult?.cNumero ?? "").trim()}`;
}

async function computePendenteViaPedidosCompra(
  appKey: string, appSecret: string,
  habilitadoMap: Map<string, string | null>,
  supabase: SupabaseClient,
): Promise<{ pendente: Map<string, number>; confiavel: boolean; problemas: string[] }> {
  const { numeros: emTransitoNumeros, codInts: emTransitoCodInts } = await fetchEmTransitoKeys(supabase);

  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - PEDIDOS_JANELA_PASSADO_DIAS);
  const fimJanela = new Date();
  fimJanela.setDate(hoje.getDate() + PEDIDOS_JANELA_FUTURO_DIAS);
  const dataDe = ddmmyyyyPed(inicio);
  const dataAte = ddmmyyyyPed(fimJanela); // [fix] cobre previsões de entrega FUTURAS (era ddmmyyyyPed(hoje) → cortava tudo a caminho)

  const items: PoItemOmie[] = [];
  const etapasInesperadas = new Set<string>();
  // [fix double-buy 2026-06-20] PAGINA ATÉ A PÁGINA VAZIA — não confiar em nTotalPaginas (Omie SUB-REPORTA →
  // lia só a 1ª página → POs aprovadas além dela sumiam → pendente subestimado → motor re-sugeria = double-buy).
  const fpsVistos = new Set<string>();     // anti-loop: página inteira repetida (Omie em loop)
  const posComoApp = new Set<string>();    // POs vistas como app (no em_transito) — de-dup + detectar divergência app↔manual
  const posComoManual = new Set<string>(); // POs contadas como manual (pendente Omie) — de-dup + detectar divergência app↔manual
  const problemas: string[] = [];          // [Codex P1] fail-closed: dado torto → NÃO grava pendente (preserva anterior)
  let pedidosVistos = 0, pedidosApp = 0, paginasLidas = 0, fim = false;

  for (let pagina = 1; pagina <= MAX_PAGINAS_PED; pagina++) {
    const resp = await callOmiePedidos(appKey, appSecret, pagina, dataDe, dataAte);
    if (resp?.faultstring) {
      if (FIM_SEM_REGISTROS.test(resp.faultstring)) { fim = true; break; }
      throw new Error(`PesquisarPedCompra fault: ${resp.faultstring}`);
    }
    const pedidos = resp?.pedidos_pesquisa ?? [];
    if (pedidos.length === 0) { fim = true; break; }   // página vazia = FIM real (não nTotalPaginas)
    const fp = fingerprintPagina(pedidos);
    if (fp && fpsVistos.has(fp)) {
      throw new Error(`PesquisarPedCompra REPETIÇÃO de página (pág ${pagina}) — abort anti-overcount/double-buy`);
    }
    fpsVistos.add(fp);
    paginasLidas++;
    for (const ped of pedidos) {
      pedidosVistos++;
      const cab = ped?.cabecalho_consulta ?? ped?.cabecalho ?? {};
      const etapa = String(cab?.cEtapa ?? "").trim();
      const cNumero = String(cab?.cNumero ?? "").trim();
      const cCodIntPed = String(cab?.cCodIntPed ?? "").trim();
      const nCodPed = String(cab?.nCodPed ?? "").trim();
      const ehApp = (cNumero && emTransitoNumeros.has(cNumero)) || (cCodIntPed && emTransitoCodInts.has(cCodIntPed));
      if (etapa && !ETAPAS_CONHECIDAS.has(etapa)) etapasInesperadas.add(etapa);
      // [Codex round5] aliases de identidade da PO (prefixadas, não-vazias) p/ correlacionar a MESMA PO entre páginas
      // mesmo quando o Omie omite campos DIFERENTES em cada aparição (nCodPed numa, cNumero noutra). O cross-check
      // app↔manual bate em QUALQUER alias compartilhada. Resíduo só no caso de identidades 100% DISJUNTAS entre
      // páginas (sem nenhuma chave em comum) — inerente/irresolvível no client (sem correlação possível).
      const aliases: string[] = [];
      if (nCodPed) aliases.push(`id:${nCodPed}`);
      if (cNumero) aliases.push(`num:${cNumero}`);
      if (cCodIntPed) aliases.push(`cod:${cCodIntPed}`);
      // De-dup vs em_transito: PO do app já é contada pelo em_transito da RPC → NÃO entra no pendente Omie. Pula CEDO
      // (não exige nCodPed: uma PO app não pode congelar o snapshot — [Codex P2 round3]). Registra TODAS as aliases
      // como app; se a MESMA PO já foi contada como manual (qualquer alias) → app+manual = double-count → fail-closed.
      if (ehApp) {
        pedidosApp++;
        if (aliases.some((a) => posComoManual.has(a))) {
          problemas.push(`PO app↔manual divergente entre páginas (${aliases.join(",")}) — double-count`);
        }
        for (const a of aliases) posComoApp.add(a);
        continue;
      }
      // Só etapa APROVADA-ABERTA (15) contribui pro pendente. Em-aprovação (10)/desconhecida não conta → ignora
      // sem exigir nCodPed nem de-dup (uma PO irrelevante não pode congelar o snapshot — [Codex P2 round3]).
      if (!ETAPAS_APROVADO_ABERTO.has(etapa)) continue;
      // [Codex P1.a] PO MANUAL etapa-aprovada que CONTA → exige nCodPed canônico (sempre presente → chave comum entre
      // páginas garantida p/ o de-dup manual-manual). Sem ele a MESMA PO somaria 2× → overcount → ruptura. Fail-closed.
      if (!nCodPed) {
        problemas.push(`PO etapa-aprovada sem nCodPed (cNumero=${cNumero || "—"}) — sem chave de de-dup`);
        continue;
      }
      // [Codex round4/5] mesma PO já vista como APP (em_transito) reaparece como manual (qualquer alias) → double-count.
      if (aliases.some((a) => posComoApp.has(a))) {
        problemas.push(`PO app↔manual divergente entre páginas (${aliases.join(",")}) — double-count`);
        continue;
      }
      // de-dup manual-manual: MESMA PO já contada (qualquer alias) reaparecendo (shift de paginação) → não soma 2×.
      if (aliases.some((a) => posComoManual.has(a))) continue;
      for (const a of aliases) posComoManual.add(a);
      // [Codex P1-novo] fail-closed contra resposta truncada no NÍVEL DO ITEM (espelho do helper coletarDaPagina):
      // item sem nCodProd COM saldo>0/qtde inválida, ou PO aprovada SEM nenhum item com SKU = resposta anômala →
      // o saldo se perderia (subcontagem → double-buy). Marca problema (etapa aqui já CONTA: é etapa-15).
      let itensComSku = 0;
      for (const it of ped?.produtos_consulta ?? []) {
        const sku = String(it.nCodProd ?? "").trim();
        // [Codex P1.c] parsing ESTRITO: Number(nQtdeRec="" / null)=0 contaria saldo CHEIO numa PO parcialmente
        // recebida = supercontagem → ruptura. parseQtd/parseRecebido → NaN em dado torto → fail-closed (problema).
        const qtde = parseQtd(it.nQtde), recebido = parseRecebido(it.nQtdeRec);
        if (!sku) {
          if (!quantidadesValidas(qtde, recebido) || saldoAReceber(qtde, recebido) > 0) {
            problemas.push(`PO ${cNumero || nCodPed} (etapa ${etapa}) item SEM nCodProd com saldo/qtde suspeita`);
          }
          continue;
        }
        itensComSku++;
        if (!habilitadoMap.has(sku)) continue;
        if (!quantidadesValidas(qtde, recebido)) {
          problemas.push(`item inválido (sku=${sku} po=${cNumero} nQtde=${it.nQtde} nQtdeRec=${it.nQtdeRec})`);
          continue;
        }
        items.push({ sku, poNumero: cNumero, etapa, qtde, recebido });
      }
      if (itensComSku === 0) {
        problemas.push(`PO aprovada sem item com SKU (po=${cNumero || nCodPed} etapa=${etapa})`);
      }
    }
    await new Promise((r) => setTimeout(r, 1100));   // rate-limit Omie entre páginas
  }
  if (!fim) {
    throw new Error(`PesquisarPedCompra excedeu ${MAX_PAGINAS_PED} páginas sem ver fim — abort anti-truncamento`);
  }
  // [Codex P1] CONFIABILIDADE do snapshot (fail-closed que PRESERVA): dado torto (problemas) ou varredura totalmente
  // vazia (0 pedidos — a OBEN sempre tem PO aberta) ⇒ pendente NÃO confiável → o caller NÃO grava a coluna (preserva
  // o último valor bom); o FÍSICO segue atualizando (não derruba o sync de estoque por 1 PO suja de fornecedor).
  const confiavel = problemas.length === 0 && pedidosVistos > 0;
  const pendente = confiavel
    ? computePendenteEntradaPorSku(items, { etapasAbertas: ETAPAS_APROVADO_ABERTO, poNumerosEmTransito: emTransitoNumeros })
    : new Map<string, number>();
  console.log(
    `[omie-sync-estoque] PesquisarPedCompra: ${paginasLidas} págs até vazia, ${pedidosVistos} pedidos abertos (${pedidosApp} do app de-dup), ` +
    `${items.length} itens habilitados, ${pendente.size} SKUs com a caminho, confiavel=${confiavel}.` +
    (problemas.length ? ` ⚠️ ${problemas.length} problema(s) → pendente PRESERVADO: ${problemas.slice(0, 3).join(" | ")}` : "") +
    (etapasInesperadas.size ? ` ⚠️ etapas fora de {15,10}: ${[...etapasInesperadas].join(",")}` : ""),
  );
  return { pendente, confiavel, problemas };
}

// ===== Marcadores do Sentinela (sync_state) — writer que faltava ao check estoque_reposicao =====
// A v2 do check ("[FONTE-ÚNICA passo 5 / P1-A]", 20260611210000) lia DOIS marcadores 1-writer (account
// minúscula) que NENHUM writer gravava (o fluxo single-source #809 foi revertido no #817) → broken
// permanente + Sentinela SURDO 17d (o incidente 30/06–02/07 passou mudo). A v3 (#1144, 20260702212000)
// voltou o check ao dado real (max(ultima_sincronizacao)) e deixou a regra: "re-promover o marcador só
// COM a edge gravando" — ESTA função é essa edge. Ordem certa de deploy: WRITER primeiro (aqui), check
// v4 depois (partir do corpo v2 preservado na 20260626150000). Semântica dos marcadores:
//   - fim de run OK → 'complete' + last_sync_at (o check v2/v4 mede a idade por last_sync_at);
//   - pendente NÃO-confiável (OBEN) → OMITE o upsert do reposicao_pendente_po: o marcador envelhece e
//     a futura v4 enxerga o "a-caminho congelado" que o frescor do físico mascara (o ponto cego que
//     motivou o P1-A — a v3 ainda não o cobre);
//   - falha total do run → 'error' no full SEM avançar last_sync_at (contrato v2/v4: 'error' = broken
//     imediato; o horário do último sucesso fica preservado para o operador).
// Best-effort: o marcador nunca derruba o sync real (padrão da irmã omie-sync-pedidos-compra).
// 'syncing' do desenho P1-A não é usado: aqui os dois upserts saem juntos no fim do run (não existe a
// janela físico→a-caminho do fluxo #809 que o estado intermediário cobria).
const MARKER_FULL = "reposicao_estoque_full";
const MARKER_PENDENTE_PO = "reposicao_pendente_po";

async function gravarMarcadorSentinela(
  supabase: SupabaseClient,
  entityType: string,
  empresa: Empresa,
  status: "complete" | "error",
  meta: Record<string, unknown>,
  errorMessage: string | null = null,
): Promise<void> {
  const nowISO = new Date().toISOString();
  const row: Record<string, unknown> = {
    entity_type: entityType,
    account: empresa.toLowerCase(),
    status,
    updated_at: nowISO,
    error_message: errorMessage,
    metadata: { ...meta, gravado_em: nowISO },
  };
  if (status === "complete") row.last_sync_at = nowISO; // 'error' preserva o último sucesso
  try {
    const { error } = await supabase
      .from("sync_state")
      .upsert(row, { onConflict: "entity_type,account" });
    if (error) throw error;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[omie-sync-estoque] marcador ${entityType} (${status}) falhou: ${msg}`);
  }
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
  console.log(`[omie-sync-estoque] ListarSaldoPendente: ${pendente.size} SKUs com entrada pendente.`);
  return pendente;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const startedAt = new Date();
  const t0 = performance.now();

  // Refs para o catch conseguir gravar o marcador 'error' (só existem após o parse/criação no try;
  // falha ANTES disso fica sem marcador — o envelhecimento do last_sync_at cobre, stale às 4h).
  let supabaseRef: SupabaseClient | null = null;
  let empresaRef: Empresa | null = null;

  try {
    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};
    const empresa: Empresa = (body?.empresa ?? "OBEN") as Empresa;
    if (empresa !== "OBEN" && empresa !== "COLACOR") {
      return new Response(
        JSON.stringify({ error: "empresa inválida. Use OBEN ou COLACOR." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { appKey, appSecret } = getOmieCredentials(empresa);
    if (!appKey || !appSecret) {
      throw new Error(`Credenciais Omie ausentes para ${empresa}`);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    supabaseRef = supabase;
    empresaRef = empresa;

    // 1) SKUs habilitados
    const { data: habilitadosRows, error: habErr } = await supabase
      .from("sku_parametros")
      .select("sku_codigo_omie, sku_descricao")
      .eq("empresa", empresa)
      .eq("habilitado_reposicao_automatica", true);

    if (habErr) throw new Error(`Erro lendo sku_parametros: ${habErr.message}`);

    const habilitados = (habilitadosRows ?? []) as Array<{
      sku_codigo_omie: number | string;
      sku_descricao: string | null;
    }>;
    const habilitadoMap = new Map<string, string | null>();
    for (const r of habilitados) {
      habilitadoMap.set(String(r.sku_codigo_omie), r.sku_descricao ?? null);
    }
    const totalEsperado = habilitadoMap.size;
    console.log(
      `[omie-sync-estoque] ${empresa}: ${totalEsperado} SKUs habilitados para reposição.`,
    );

    if (totalEsperado === 0) {
      // Run vazio legítimo = complete (só o full; deixar o pendente_po envelhecer aqui é sinal útil —
      // reposição desabilitada em massa merece atenção humana, não um complete fabricado).
      await gravarMarcadorSentinela(supabase, MARKER_FULL, empresa, "complete", {
        trigger: "run",
        sincronizados: 0,
        nota: "nenhum SKU habilitado",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          empresa,
          total_skus_esperados: 0,
          mensagem: "Nenhum SKU habilitado, nada a sincronizar.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2-3) Paginar Omie — ListarPosEstoque (físico + reservado)
    // IMPORTANTE: o método retorna UMA LINHA POR LOCAL DE ESTOQUE.
    // Se o mesmo nCodProd está em N locais (matriz, filial, depósito),
    // precisamos SOMAR físico/reservado/pendente de todos os locais —
    // sobrescrever (Map.set) gerava estoque menor que o do ME.
    const dataPosicao = ddmmyyyy(new Date());
    const encontrados = new Map<string, { fisico: number; reservado: number; pendente: number; locais: number }>();

    let page = 1;
    let totalPaginas = 1;
    let totalRegistros = 0;

    do {
      const resp = await callOmie<OmiePosEstoqueResponse>(
        appKey, appSecret, "ListarPosEstoque",
        { nPagina: page, nRegPorPagina: PAGE_SIZE, dDataPosicao: dataPosicao, cExibeTodos: "S" },
      );
      totalPaginas = resp.nTotPaginas ?? 1;
      totalRegistros = resp.nTotRegistros ?? totalRegistros;
      const lista = resp.produtos ?? [];
      for (const item of lista) {
        const codigo = String(item.nCodProd ?? "").trim();
        if (!codigo) continue;
        if (!habilitadoMap.has(codigo)) continue;
        const acc = encontrados.get(codigo) ?? { fisico: 0, reservado: 0, pendente: 0, locais: 0 };
        acc.fisico += Number(item.fisico ?? 0);
        acc.reservado += Number(item.reservado ?? 0);
        acc.pendente += Number(item.nPendente ?? 0);
        acc.locais += 1;
        encontrados.set(codigo, acc);
      }
      console.log(
        `[omie-sync-estoque] ListarPosEstoque pág ${page}/${totalPaginas} — ${lista.length} itens, ${encontrados.size}/${totalEsperado} casados.`,
      );
      page++;
    } while (page <= totalPaginas);

    console.log(
      `[omie-sync-estoque] varredura concluída: ${totalRegistros} no Omie, ${encontrados.size}/${totalEsperado} habilitados encontrados.`,
    );

    // 3.b) "A caminho" (estoque_pendente_entrada) — pedidos de compra ABERTOS do Omie.
    // OBEN: via PesquisarPedCompra (pega previsão FUTURA de PO aprovada que o ListarSaldoPendente perdia —
    //   incidente 2026-06-11, FUNDO PU/1054). Erro de VARREDURA (rede/fault/loop/truncamento) é FATAL (throw →
    //   sync falha → Sentinela pega o congelado). Já dado torto/varredura vazia NÃO derruba o sync: o pendente
    //   vira NÃO confiável e a coluna é PRESERVADA no upsert (o físico segue fresco). [Codex P1 2026-06-20]
    // COLACOR: mantém ListarSaldoPendente, não-fatal (reposição é OBEN; etapa-map do COLACOR não confirmada).
    let pendenteEntrada = new Map<string, number>();
    let pendenteConfiavel = true; // COLACOR (ListarSaldoPendente) sempre aplica; OBEN é gated pela confiabilidade
    let pendenteProblemas: string[] = [];
    if (empresa === "OBEN") {
      const r = await computePendenteViaPedidosCompra(appKey, appSecret, habilitadoMap, supabase);
      pendenteEntrada = r.pendente;
      pendenteConfiavel = r.confiavel;
      pendenteProblemas = r.problemas;
    } else {
      try {
        pendenteEntrada = await computePendenteViaSaldoPendente(appKey, appSecret, habilitadoMap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[omie-sync-estoque] COLACOR ListarSaldoPendente falhou (não-fatal): ${msg}`);
      }
    }
    // [Codex P1 round3] pendente OBEN não confiável → PRESERVADO (físico segue fresco, evita double-buy/ruptura por
    // número errado/zerado). console.error + flag no summary = sinal nos logs; o alerta PROATIVO (Sentinela enxergar
    // o pendente congelado, que o frescor do físico mascara) depende do marcador sync_state — follow-up (#809 passo 5).
    if (empresa === "OBEN" && !pendenteConfiavel) {
      console.error(
        `[omie-sync-estoque] ⚠️ pendente OBEN NÃO confiável → PRESERVADO. ${pendenteProblemas.length} problema(s): ${pendenteProblemas.slice(0, 5).join(" | ")}`,
      );
    }

    // 4) UPSERT em sku_estoque_atual (valores já agregados por SKU)
    // [Codex P1] estoque_pendente_entrada só é gravado quando o snapshot é CONFIÁVEL; senão a coluna é OMITIDA
    // (no UPDATE o PostgREST não toca colunas ausentes → preserva o último valor bom) e o físico segue fresco.
    const upsertRows = Array.from(encontrados.entries()).map(([codigo, agg]) => {
      const row: Record<string, unknown> = {
        empresa,
        sku_codigo_omie: codigo,
        estoque_fisico: agg.fisico,
        estoque_disponivel: agg.fisico - agg.reservado,
        ultima_sincronizacao: new Date().toISOString(),
        fonte_sync: agg.locais > 1 ? `ListarPosEstoque(${agg.locais} locais)` : "ListarPosEstoque",
      };
      if (pendenteConfiavel) row.estoque_pendente_entrada = pendenteEntrada.get(codigo) ?? 0;
      return row;
    });

    let sincronizados = 0;
    const errosUpsert: Array<{ sku: string; erro: string }> = [];
    // Upsert em chunks para evitar payload gigante
    const CHUNK = 200;
    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const slice = upsertRows.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("sku_estoque_atual")
        .upsert(slice, { onConflict: "empresa,sku_codigo_omie" });
      if (error) {
        // Fallback: tentar individualmente para isolar SKU problemático
        console.error(
          `[omie-sync-estoque] erro upsert chunk ${i}-${i + slice.length}: ${error.message}. Tentando individual.`,
        );
        for (const row of slice) {
          const { error: e2 } = await supabase
            .from("sku_estoque_atual")
            .upsert(row, { onConflict: "empresa,sku_codigo_omie" });
          if (e2) {
            errosUpsert.push({ sku: String(row.sku_codigo_omie), erro: e2.message });
          } else {
            sincronizados++;
          }
        }
      } else {
        sincronizados += slice.length;
      }
    }

    // 5) SKUs habilitados que não apareceram → marca inativo + alerta
    const naoEncontrados: string[] = [];
    for (const codigo of habilitadoMap.keys()) {
      if (!encontrados.has(codigo)) naoEncontrados.push(codigo);
    }

    let alertasNovos = 0;
    if (naoEncontrados.length > 0) {
      console.warn(
        `[omie-sync-estoque] ${naoEncontrados.length} SKUs habilitados não vieram do Omie:`,
        naoEncontrados,
      );

      const statusRows = naoEncontrados.map((codigo) => ({
        empresa,
        sku_codigo_omie: codigo,
        sku_descricao: habilitadoMap.get(codigo) ?? null,
        ativo_no_omie: false,
        ultima_sincronizacao: new Date().toISOString(),
        fonte_sincronizacao: "nao_apareceu_em_ListarPosicaoEstoque",
      }));

      // Para preservar data_inativacao existente usamos fetch + upsert seletivo
      const { data: existentes } = await supabase
        .from("sku_status_omie")
        .select("sku_codigo_omie, data_inativacao")
        .eq("empresa", empresa)
        .in("sku_codigo_omie", naoEncontrados);

      const existentesMap = new Map(
        (existentes ?? []).map((r) => [r.sku_codigo_omie, r.data_inativacao]),
      );

      const nowIso = new Date().toISOString();
      const enrichedStatus = statusRows.map((r) => ({
        ...r,
        data_inativacao: existentesMap.get(r.sku_codigo_omie) ?? nowIso,
      }));

      const { error: statusErr } = await supabase
        .from("sku_status_omie")
        .upsert(enrichedStatus, { onConflict: "empresa,sku_codigo_omie" });
      if (statusErr) {
        console.error(
          `[omie-sync-estoque] erro upsert sku_status_omie: ${statusErr.message}`,
        );
      }

      // Eventos pendentes existentes para evitar duplicar
      const { data: eventosExistentes } = await supabase
        .from("eventos_outlier")
        .select("sku_codigo_omie")
        .eq("empresa", empresa)
        .eq("tipo", "sku_inativado_omie")
        .eq("status", "pendente")
        .in("sku_codigo_omie", naoEncontrados);

      const jaTemEvento = new Set(
        (eventosExistentes ?? []).map((e) => e.sku_codigo_omie),
      );

      const novosEventos = naoEncontrados
        .filter((c) => !jaTemEvento.has(c))
        .map((codigo) => ({
          empresa,
          sku_codigo_omie: codigo,
          sku_descricao: habilitadoMap.get(codigo) ?? null,
          tipo: "sku_inativado_omie",
          severidade: "atencao",
          data_evento: new Date().toISOString().slice(0, 10),
          detalhes: {
            mensagem:
              "SKU foi inativado no Omie. Decidir: (1) merge histórico com outro SKU, (2) descadastrar do módulo de reposição, (3) reativar manualmente no Omie.",
            detectado_em: new Date().toISOString(),
            fonte: "omie-sync-estoque",
          },
        }));

      if (novosEventos.length > 0) {
        const { error: evErr } = await supabase
          .from("eventos_outlier")
          .insert(novosEventos);
        if (evErr) {
          console.error(
            `[omie-sync-estoque] erro inserindo eventos_outlier: ${evErr.message}`,
          );
        } else {
          alertasNovos = novosEventos.length;
        }
      }
    }

    const finishedAt = new Date();
    const duracaoMs = Math.round(performance.now() - t0);

    const summary = {
      ok: true,
      empresa,
      sync_iniciado_em: startedAt.toISOString(),
      sync_concluido_em: finishedAt.toISOString(),
      duracao_ms: duracaoMs,
      total_skus_esperados: totalEsperado,
      sincronizados,
      nao_encontrados: naoEncontrados.length,
      erros_upsert: errosUpsert.length,
      alertas_novos: alertasNovos,
      pendente_confiavel: pendenteConfiavel,
      pendente_problemas: pendenteProblemas.length,
      paginas_omie: totalPaginas,
      total_produtos_omie: totalRegistros,
      lista_nao_encontrados: naoEncontrados,
      lista_erros: errosUpsert,
    };

    console.log("[omie-sync-estoque] resumo:", JSON.stringify(summary));

    // Marcadores do Sentinela (check estoque_reposicao): full sempre; pendente_po SÓ OBEN e SÓ quando o
    // snapshot do a-caminho foi realmente gravado nesta rodada — não-confiável deixa o marcador envelhecer
    // (stale/broken) = o alerta de "a-caminho congelado". COLACOR não tem esteira de reposição (o check é
    // OBEN-only); o full dela fica gravado por uniformidade, o pendente não (ListarSaldoPendente é
    // best-effort não-fatal lá — um 'complete' incondicional seria sinal fabricado).
    await gravarMarcadorSentinela(supabase, MARKER_FULL, empresa, "complete", {
      trigger: "run",
      sincronizados,
      nao_encontrados: naoEncontrados.length,
      duracao_ms: duracaoMs,
    });
    if (empresa === "OBEN" && pendenteConfiavel) {
      await gravarMarcadorSentinela(supabase, MARKER_PENDENTE_PO, empresa, "complete", {
        trigger: "run",
        skus_com_pendente: pendenteEntrada.size,
        duracao_ms: duracaoMs,
      });
    }

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.startsWith("AUTH_ERROR");
    console.error(
      `[omie-sync-estoque] ${isAuth ? "CRÍTICO AUTH" : "ERRO"}: ${msg}`,
    );
    // Falha TOTAL do run → 'error' no full marker (broken imediato no check), sem avançar last_sync_at.
    if (supabaseRef && empresaRef) {
      await gravarMarcadorSentinela(supabaseRef, MARKER_FULL, empresaRef, "error", { trigger: "run" }, msg);
    }
    return new Response(
      JSON.stringify({
        ok: false,
        error: msg,
        critical: isAuth,
        duracao_ms: Math.round(performance.now() - t0),
      }),
      {
        status: isAuth ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
