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
const PEDIDOS_JANELA_DIAS = 180; // janela de criação; PO aberta mais velha que isso é rara (→ pior caso: double-buy)
const ETAPAS_APROVADO_ABERTO = new Set<string>(["15"]); // OBEN: 15=Aprovado (confirmado 2026-06-11)
const ETAPAS_CONHECIDAS = new Set<string>(["15", "10"]); // 10=Em Aprovação; loga qualquer outra p/ pegar surpresa

interface OmiePedItem { nCodProd?: number | string; nQtde?: number; nQtdeRec?: number; [k: string]: unknown; }
interface OmiePedCab { nCodPed?: number | string; cNumero?: string; cCodIntPed?: string; cEtapa?: string; [k: string]: unknown; }
interface OmiePedConsulta { cabecalho_consulta?: OmiePedCab; cabecalho?: OmiePedCab; produtos_consulta?: OmiePedItem[]; [k: string]: unknown; }
interface OmiePedResponse { pedidos_pesquisa?: OmiePedConsulta[]; nTotalPaginas?: number; faultstring?: string; faultcode?: string; [k: string]: unknown; }

// ── Helper puro (espelho VERBATIM de src/lib/reposicao/pendente-entrada-po.ts; 18 testes vitest) ──
interface PoItemOmie { sku: string; poNumero: string; etapa: string; qtde: number; recebido: number; }
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
          nRegsPorPagina: 50,
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

async function computePendenteViaPedidosCompra(
  appKey: string, appSecret: string,
  habilitadoMap: Map<string, string | null>,
  supabase: SupabaseClient,
): Promise<Map<string, number>> {
  const { numeros: emTransitoNumeros, codInts: emTransitoCodInts } = await fetchEmTransitoKeys(supabase);

  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - PEDIDOS_JANELA_DIAS);
  const dataDe = ddmmyyyyPed(inicio);
  const dataAte = ddmmyyyyPed(hoje);

  const items: PoItemOmie[] = [];
  const etapasInesperadas = new Set<string>();
  let pagina = 1, totalPaginas = 1, pedidosVistos = 0, pedidosApp = 0;

  do {
    const resp = await callOmiePedidos(appKey, appSecret, pagina, dataDe, dataAte);
    if (resp?.faultstring) {
      if (/not\s*found|sem\s*registros|n[ãa]o\s*encontrado/i.test(resp.faultstring)) break;
      throw new Error(`PesquisarPedCompra fault: ${resp.faultstring}`);
    }
    totalPaginas = resp?.nTotalPaginas ?? 1;
    const pedidos = resp?.pedidos_pesquisa ?? [];
    for (const ped of pedidos) {
      pedidosVistos++;
      const cab = ped?.cabecalho_consulta ?? ped?.cabecalho ?? {};
      const etapa = String(cab?.cEtapa ?? "").trim();
      const cNumero = String(cab?.cNumero ?? "").trim();
      const cCodIntPed = String(cab?.cCodIntPed ?? "").trim();
      if (etapa && !ETAPAS_CONHECIDAS.has(etapa)) etapasInesperadas.add(etapa);
      // De-dup: PO do app (já contada pelo em_transito) → pula (anti double-count).
      if ((cNumero && emTransitoNumeros.has(cNumero)) || (cCodIntPed && emTransitoCodInts.has(cCodIntPed))) {
        pedidosApp++;
        continue;
      }
      for (const it of ped?.produtos_consulta ?? []) {
        const sku = String(it.nCodProd ?? "").trim();
        if (!sku || !habilitadoMap.has(sku)) continue;
        items.push({
          sku, poNumero: cNumero, etapa,
          qtde: Number(it.nQtde ?? 0), recebido: Number(it.nQtdeRec ?? 0),
        });
      }
    }
    pagina++;
    if (pagina <= totalPaginas) await new Promise((r) => setTimeout(r, 1100));
  } while (pagina <= totalPaginas);

  const pendente = computePendenteEntradaPorSku(items, {
    etapasAbertas: ETAPAS_APROVADO_ABERTO,
    poNumerosEmTransito: emTransitoNumeros,
  });
  console.log(
    `[omie-sync-estoque] PesquisarPedCompra: ${pedidosVistos} pedidos abertos (${pedidosApp} do app de-dup), ` +
    `${items.length} itens habilitados, ${pendente.size} SKUs com a caminho.` +
    (etapasInesperadas.size ? ` ⚠️ etapas fora de {15,10}: ${[...etapasInesperadas].join(",")} (revisar whitelist)` : ""),
  );
  return pendente;
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
    // OBEN: via PesquisarPedCompra (pega previsão FUTURA de PO aprovada que o ListarSaldoPendente
    //   perdia — incidente 2026-06-11, FUNDO PU/1054). FATAL de propósito: pending de entrada é
    //   money-path; a falha SILENCIOSA (=0) foi o que causou o re-sugerir. Se falhar, a sync inteira
    //   falha → sku_estoque_atual não atualiza → o Sentinela (check estoque_reposicao) pega o congelado.
    // COLACOR: mantém ListarSaldoPendente, não-fatal (reposição é OBEN; etapa-map do COLACOR não confirmada).
    let pendenteEntrada = new Map<string, number>();
    if (empresa === "OBEN") {
      pendenteEntrada = await computePendenteViaPedidosCompra(appKey, appSecret, habilitadoMap, supabase);
    } else {
      try {
        pendenteEntrada = await computePendenteViaSaldoPendente(appKey, appSecret, habilitadoMap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[omie-sync-estoque] COLACOR ListarSaldoPendente falhou (não-fatal): ${msg}`);
      }
    }

    // 4) UPSERT em sku_estoque_atual (valores já agregados por SKU)
    const upsertRows = Array.from(encontrados.entries()).map(([codigo, agg]) => {
      return {
        empresa,
        sku_codigo_omie: codigo,
        estoque_fisico: agg.fisico,
        estoque_disponivel: agg.fisico - agg.reservado,
        estoque_pendente_entrada: pendenteEntrada.get(codigo) ?? 0,
        ultima_sincronizacao: new Date().toISOString(),
        fonte_sync: agg.locais > 1 ? `ListarPosEstoque(${agg.locais} locais)` : "ListarPosEstoque",
      };
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
            errosUpsert.push({ sku: row.sku_codigo_omie, erro: e2.message });
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
      paginas_omie: totalPaginas,
      total_produtos_omie: totalRegistros,
      lista_nao_encontrados: naoEncontrados,
      lista_erros: errosUpsert,
    };

    console.log("[omie-sync-estoque] resumo:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = msg.startsWith("AUTH_ERROR");
    console.error(
      `[omie-sync-estoque] ${isAuth ? "CRÍTICO AUTH" : "ERRO"}: ${msg}`,
    );
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
