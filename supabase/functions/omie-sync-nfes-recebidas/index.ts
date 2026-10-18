// Edge Function: omie-sync-nfes-recebidas
// Sincroniza NFes de entrada (recebidas) do Omie (Oben + Colacor) para purchase_orders_tracking.
// Pública (verify_jwt = false) — acionada via POST manual ou cron.
//
// Métodos Omie usados (endpoint /api/v1/produtos/recebimentonfe/):
//   - ListarRecebimentos  → lista NFes do período (cabec + infoCadastro)
//   - ConsultarRecebimento → detalha 1 NFe e traz itensRecebimento[].itensInfoAdic.nNumPedCompra
//
// Estratégia de vínculo NFe ↔ Pedido:
//   1) Lista NFes do período via ListarRecebimentos. A lista traz CT-e (modelo 57, o conhecimento
//      de frete) junto: quando a chave CRUA e o `cModeloNFe` dizem 57, o documento sai AQUI, antes
//      de consulta e de escrita, contado em `ctes_ignorados` — o CT-e não tem item nem pedido, e
//      virava linha órfã do rastreio (135 linhas, 0 com leadtime; parte B, 2026-10-05).
//   2) Para CADA NFe, chama ConsultarRecebimento(nIdReceb) e extrai
//      a lista DEDUPLICADA de itensRecebimento[].itensInfoAdic.nNumPedCompra.
//      Esses são CNUMERO de pedidos de compra (string, ex: "2083548"), NÃO o ID interno.
//   3) Para cada nNumPedCompra:
//        - SELECT em purchase_orders_tracking WHERE empresa = ? AND numero_pedido = ?
//        - se achar (1+ linhas) → UPDATE em TODAS preenchendo
//          T2, T4, nfe_chave_acesso, nfe_numero, nfe_serie, transp_*, status
//   4) Se a NFe não casar com NENHUM nNumPedCompra (ou não tiver pedidos no detalhe)
//      → INSERT linha órfã: omie_codigo_pedido = -nIdReceb, grupo_leadtime = "OUTRO".
//
// Body opcional:
//   { "empresa": "OBEN" | "COLACOR" | "ALL", "dias": 30, "fornecedor_codigo_omie": 8689681266 }

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { classificarSonda, EDGE, EFEITO, erroSondaAmbigua, FONTE, respostaSonda, VERSAO } from "./versao.ts";
import { classifyOmieResponse, computeBackoffMs } from "./retry.ts";
import { cabeEspera, timeoutRequestMs } from "../_shared/omie-deadline.ts";
import { atenderSondaOptions } from '../_shared/sonda-cron.ts';
import { classificarModeloRecebimento } from "../_shared/modelo-documento-fiscal.ts";
import { ehFimDaListagem, ehFimDaListagemLarga, pedirProximaPaginaLarga } from "./listagem.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  extrairPedidosDoDetalhe,
  type LinhaPedido,
  montarPatchVinculo,
  type OrfaParaReconciliar,
  reconciliarOrfas,
  type ReconciliacaoSummary,
} from "./reconciliacao.ts";
import type { PedidoDoContrato } from "./associacao.ts";
import { type DocumentoRevisita, lerRevisitaDias, novaRevisitaSummary, type PortaRevisita, revisitarJanela, type RevisitaSummary } from "./revisita.ts";
import { capturarPedidosDaFila, executarFaseSombra, type ItemFilaSombra, novaSombraSummary, type PortaSombra, type SombraSummary } from "./sombra.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const PAGE_SIZE = 50;
const RATE_LIMIT_DELAY_MS = 1100;
const MAX_RETRIES = 3;

type Empresa = "OBEN" | "COLACOR";

interface RequestBody {
  empresa?: "OBEN" | "COLACOR" | "ALL";
  dias?: number;
  fornecedor_codigo_omie?: number;
  data_inicial?: string; // dd/mm/yyyy — sobrepõe `dias` se fornecido
  data_final?: string;   // dd/mm/yyyy — sobrepõe `dias` se fornecido
  apenas_backfill?: boolean; // pula ListarRecebimentos e roda só o backfill retroativo
  pular_backfill?: boolean;  // roda só ListarRecebimentos sem backfill
  revisita_dias?: number;    // 1..60: revisita a janela larga no fim do run (revisita.ts); ausente = não revisita
}

interface BackfillSummary {
  nfes_identificadas_para_backfill: number;
  nfes_backfilled: number;
  nfes_pulou_por_timeout: number;
  erros: number;
}

interface EmpresaSummary extends Partial<ContagemModelo> {
  empresa: Empresa;
  nfes_processadas: number;
  consultas_detalhadas: number;       // quantas ConsultarRecebimento rodaram com sucesso
  pedidos_vinculados: number;         // NFes que casaram com 1+ pedido real
  nfes_com_multiplos_pedidos: number; // NFes que referenciaram 2+ pedidos distintos
  nfes_orfas: number;                 // NFes inseridas como órfãs
  vinculos_criados_total: number;     // soma de UPDATEs em linhas de pedido (NFe×pedido)
  erros: number;
  interrompido_por_timeout?: boolean;
  /** Ausente quando o passo não rodou (timeout do laço) — nunca um 0 que afirma "medi". */
  reconciliacao?: ReconciliacaoSummary;
  /** Sombra da associação NF↔PO (sombra.ts): saúde própria, distinta da do vínculo. */
  sombra?: SombraSummary;
  /** Revisita da janela larga (revisita.ts). Ausente quando o run não pediu `revisita_dias`. */
  revisita?: RevisitaSummary;
  backfill?: BackfillSummary;
}

/**
 * O modelo do documento (_shared/modelo-documento-fiscal.ts), por nIdReceb válido e distinto no run.
 * Só existe no resumo do run que LISTOU: em `apenas_backfill` e no erro fatal fica AUSENTE do results,
 * nunca um 0 que afirma "medi e não havia". (Resíduo conhecido: o `ListarRecebimentos` que lança já
 * na página 1, ou o guarda de tempo antes dela, deixam 0 sem nada medido — distinguíveis pelo status
 * `error` e por `interrompido_por_timeout`.) `erros` NÃO fecha a conta com estes: conta falha de
 * página e pode contar 2× o mesmo documento. O que fecha é a identidade derivada
 * `documentos_listados − ctes_ignorados − nfes_processadas` = documentos que falharam no caminho de
 * NF-e (detalhe ou escrita). A conferência externa é contra o step de CT-e do MESMO tick do
 * orquestrador (mesma janela): `ctes_ignorados` ≈ `ctes_processados` dele.
 */
interface ContagemModelo {
  documentos_listados: number;        // nIdReceb válido e distinto que o run viu, CT-e incluído
  ctes_ignorados: number;             // chave E cabeçalho = 57: fora do rastreio, sem consulta nem escrita
  modelo_divergente: number;          // chave e cabeçalho legíveis e diferentes: segue o fluxo de NF-e
  modelo_ausente: number;             // algum dos dois ilegível ou faltando: segue o fluxo de NF-e
}

const TIMEOUT_GUARD_MS = 130_000;
// Guard do loop PRINCIPAL (syncEmpresa). Com retry em transitório, o loop pode
// consumir toda a janela e deixar a linha fin_sync_log 'running' órfã (sem
// completeSync). Cede ANTES do backfill (130s) p/ sobrar tempo ao completeSync.
const MAIN_LOOP_GUARD_MS = 120_000;
// Teto de RELÓGIO por request (#2017). Os guards acima são do RUN e só são LIDOS entre páginas —
// um socket pendurado nunca devolve o controle ao loop, então o guard não chega a ser consultado
// e o isolate morre com a linha fin_sync_log 'running' órfã, exatamente o que os 130s protegiam.
const FETCH_TIMEOUT_MS = 25_000;

// Tipos minimos pra responses da Omie (campos opcionais — Omie nem sempre devolve tudo)
interface OmieNFeCabec {
  /** A Omie devolve ora número, ora string — quem lê normaliza (e rejeita não-numérico). */
  nIdReceb?: number | string;
  cChaveNFe?: string;
  cChaveNfe?: string;
  nIdFornecedor?: number;
  cRazaoSocial?: string;
  cNome?: string;
  cCNPJ_CPF?: string;
  cNumeroNFe?: string;
  cSerieNFe?: string;
  /** "55" (NF-e) ou "57" (CT-e) — string em 210 de 210 órfãs medidas. Quem lê é o classificador estrito. */
  cModeloNFe?: string;
  dEmissaoNFe?: string;
  transporte?: OmieNFeTransporte;
}

interface OmieNFeInfoCadastro {
  cCancelada?: string;
  cRecebido?: string;
  cFaturado?: string;
  dRec?: string;
  hRec?: string;
}

interface OmieNFeTransporte {
  cCnpjCpfTransp?: string;
  cRazaoTransp?: string;
  cNomeTransp?: string;
}

interface OmieNFeListItem {
  cabec?: OmieNFeCabec;
  infoCadastro?: OmieNFeInfoCadastro;
  transporte?: OmieNFeTransporte;
}

interface OmieListRecebimentosResponse {
  nTotalPaginas?: number;
  recebimentos?: OmieNFeListItem[];
  faultstring?: string;
}

interface OmieItensInfoAdic {
  nNumPedCompra?: string | number;
}

interface OmieItemRecebimento {
  itensInfoAdic?: OmieItensInfoAdic;
}

interface OmieConsultarRecebimentoResponse extends OmieNFeListItem {
  itensRecebimento?: OmieItemRecebimento[];
  faultstring?: string;
}

type OmieGenericResponse =
  | OmieListRecebimentosResponse
  | OmieConsultarRecebimentoResponse
  | { faultstring?: string; raw?: string };

interface PurchaseOrderTrackingRow {
  id: string;
  status?: string | null;
  t2_data_faturamento?: string | null;
  t4_data_recebimento?: string | null;
  nfe_chave_acesso?: string | null;
  raw_data?: Record<string, unknown> | null;
  /** Sinal do recebimento em coluna DEDICADA (o raw_data é multi-writer e perde o valor). */
  nid_receb?: number | null;
  transportadora_nome?: string | null;
  transportadora_cnpj?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatDateBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Janela `dtEmissao` dos últimos `dias` (laço principal e revisita): um só cálculo de "hoje". */
function janelaDeDias(dias: number): { dataDe: string; dataAte: string } {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - dias);
  return { dataDe: formatDateBR(inicio), dataAte: formatDateBR(hoje) };
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

function getCredentials(empresa: Empresa): { app_key: string; app_secret: string } {
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
  call: "ListarRecebimentos" | "ConsultarRecebimento",
  param: Record<string, unknown>,
  deadline: number,
  /** Instante antes do fetch de CADA tentativa: a última chamada é a da resposta devolvida (carimbo da sombra). */
  aoTentar?: (iso: string) => void,
): Promise<OmieGenericResponse> {
  const body = { call, app_key, app_secret, param: [param] };

  // Retry alinhado às edges irmãs (omie-vendas-sync): retenta rate-limit E
  // transitório da Omie (SOAP-ERROR/Application Server/timeout) E HTTP 5xx, com
  // backoff. 4xx (não-429) falha alto. Após esgotar, LANÇA (OMIE_TRANSIENT) —
  // nunca devolve faultstring transitório ao caller, senão o syncEmpresa o leria
  // como erro de negócio e abortaria a página (o incidente OBEN de 05/07).
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // O teto do request ENCOLHE conforme o run se aproxima do deadline. LANÇA quando não sobra
    // tempo viável: deadline NÃO é transitório (não leva o prefixo OMIE_TRANSIENT), é o fim do
    // orçamento deste run — retentar não faria diferença nenhuma.
    const timeoutMs = timeoutRequestMs(Date.now(), deadline, FETCH_TIMEOUT_MS);
    if (timeoutMs === 0) {
      throw new Error(`Omie ${call}: deadline do run atingido antes da chamada`);
    }
    aoTentar?.(new Date().toISOString());
    const res = await fetch(OMIE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: OmieGenericResponse;
    try { json = JSON.parse(text) as OmieGenericResponse; } catch { json = { raw: text }; }

    const fs = json?.faultstring ? String(json.faultstring) : undefined;
    const verdict = classifyOmieResponse(res.status, fs);

    if (verdict.kind === "retry") {
      if (attempt < MAX_RETRIES) {
        const delay = computeBackoffMs(fs ?? "", attempt);
        // Backoff que cruza o deadline é sono que nunca acorda — o isolate morre DENTRO do sleep,
        // sem completeSync, e sobra a linha 'running' órfã que o guard de 130s existe para evitar.
        if (!cabeEspera(Date.now(), deadline, delay)) {
          throw new Error(`Omie ${call}: ${verdict.reason} e o backoff de ${delay / 1000}s não cabe antes do deadline do run`);
        }
        console.warn(`[sync-nfes] ${call} ${verdict.reason} (retry ${attempt + 1}/${MAX_RETRIES}) wait ${delay / 1000}s`);
        await sleep(delay);
        continue;
      }
      throw new Error(`OMIE_TRANSIENT ${call}: ${verdict.reason === "rate_limit" ? "rate limit" : "erro transitório"} persistiu após ${MAX_RETRIES} retries`);
    }
    if (verdict.kind === "permanent") {
      throw new Error(`Omie ${call} HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    // "ok" | "fault" → devolve ao caller (fault: ex.: "sem registros" tratado no syncEmpresa)
    return json;
  }
  throw new Error(`Omie ${call}: retries esgotados`); // inalcançável — o loop sempre retorna ou lança
}

interface MappedNFe {
  chave: string | null;
  fornecedor_codigo: number | null;
  fornecedor_nome: string | null;
  fornecedor_cnpj: string | null;
  numero: string | null;
  serie: string | null;
  data_emissao_iso: string | null;
  data_recebimento_iso: string | null;
  cancelada: boolean;
  faturada: boolean;
  recebida: boolean;
  status: "FATURADO" | "RECEBIDO" | "CANCELADO";
  transp_cnpj: string | null;
  transp_nome: string | null;
}

function mapNFe(nfe: OmieNFeListItem | OmieConsultarRecebimentoResponse): MappedNFe {
  const cab: OmieNFeCabec = nfe?.cabec ?? {};
  const info: OmieNFeInfoCadastro = nfe?.infoCadastro ?? {};
  const transp: OmieNFeTransporte = cab?.transporte ?? nfe?.transporte ?? {};

  const cancelada = String(info?.cCancelada ?? "N").toUpperCase() === "S";
  const recebida = String(info?.cRecebido ?? "N").toUpperCase() === "S";
  const faturada = String(info?.cFaturado ?? "N").toUpperCase() === "S";

  let status: "FATURADO" | "RECEBIDO" | "CANCELADO" = "FATURADO";
  if (cancelada) status = "CANCELADO";
  else if (recebida) status = "RECEBIDO";
  else if (faturada) status = "FATURADO";

  return {
    chave: (cab?.cChaveNFe ?? cab?.cChaveNfe)
      ? String(cab.cChaveNFe ?? cab.cChaveNfe).replace(/\D/g, "").slice(0, 44)
      : null,
    fornecedor_codigo: cab?.nIdFornecedor ? Number(cab.nIdFornecedor) : null,
    fornecedor_nome: cab?.cRazaoSocial ?? cab?.cNome ?? null,
    fornecedor_cnpj: cab?.cCNPJ_CPF ? String(cab.cCNPJ_CPF).replace(/\D/g, "") : null,
    numero: cab?.cNumeroNFe ?? null,
    serie: cab?.cSerieNFe ?? null,
    data_emissao_iso: parseBRDateToISO(cab?.dEmissaoNFe, "00:00:00"),
    data_recebimento_iso: recebida ? parseBRDateToISO(info?.dRec, info?.hRec) : null,
    cancelada,
    faturada,
    recebida,
    status,
    transp_cnpj: transp?.cCnpjCpfTransp ? String(transp.cCnpjCpfTransp).replace(/\D/g, "") : null,
    transp_nome: transp?.cRazaoTransp ?? transp?.cNomeTransp ?? null,
  };
}

/**
 * Atualiza TODAS as linhas de purchase_orders_tracking (empresa, numero_pedido = num)
 * com os dados da NFe. Retorna quantas linhas foram atualizadas.
 */
async function updateLinhasDoPedido(
  supabase: SupabaseClient,
  empresa: Empresa,
  numeroContrato: string,
  fornecedorCodigo: number | null,
  m: MappedNFe,
): Promise<number> {
  let q = supabase
    .from("purchase_orders_tracking")
    .select("id, status, t2_data_faturamento, t4_data_recebimento")
    .eq("empresa", empresa)
    .eq("numero_contrato_fornecedor", numeroContrato);
  if (fornecedorCodigo) {
    q = q.eq("fornecedor_codigo_omie", fornecedorCodigo);
  }
  const { data, error: selErr } = await q;
  if (selErr) throw selErr;
  const linhas = (data ?? []) as LinhaPedido[];
  if (linhas.length === 0) return 0;

  let atualizadas = 0;
  for (const linha of linhas) {
    const updateRow = montarPatchVinculo(linha, m, new Date().toISOString());

    const { error: updErr } = await supabase
      .from("purchase_orders_tracking")
      .update(updateRow)
      .eq("id", linha.id);
    if (updErr) throw updErr;
    atualizadas++;
  }
  return atualizadas;
}

async function insertOrfa(
  supabase: SupabaseClient,
  empresa: Empresa,
  nfe: OmieNFeListItem,
  m: MappedNFe,
  nIdReceb: number,
): Promise<void> {
  if (!m.fornecedor_codigo) {
    throw new Error(`NFe ${m.chave} sem nIdFornecedor — não pode inserir órfã`);
  }
  const insertRow: Record<string, unknown> = {
    empresa,
    omie_codigo_pedido: -Math.abs(nIdReceb),
    fornecedor_codigo_omie: m.fornecedor_codigo,
    fornecedor_nome: m.fornecedor_nome,
    fornecedor_cnpj: m.fornecedor_cnpj,
    grupo_leadtime: "OUTRO",
    status: m.status,
    t1_data_pedido: m.data_emissao_iso,
    t2_data_faturamento: m.data_emissao_iso,
    t4_data_recebimento: m.recebida ? m.data_recebimento_iso : null,
    nfe_chave_acesso: m.chave,
    nfe_numero: m.numero,
    nfe_serie: m.serie,
    transportadora_cnpj: m.transp_cnpj,
    transportadora_nome: m.transp_nome,
    raw_data: nfe,
    // Coluna dedicada: a órfã nasce com o sinal já resolvido, então nunca entra na fila
    // do backfill. (O raw_data aqui é do recebimento, mas é multi-writer e não sobrevive.)
    nid_receb: nIdReceb,
  };

  const { data: existing } = await supabase
    .from("purchase_orders_tracking")
    .select("id")
    .eq("empresa", empresa)
    .eq("omie_codigo_pedido", -Math.abs(nIdReceb))
    .maybeSingle();

  if (existing?.id) {
    const { error: updErr } = await supabase
      .from("purchase_orders_tracking")
      .update({ ...insertRow, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (updErr) throw updErr;
  } else {
    const { error: insErr } = await supabase
      .from("purchase_orders_tracking")
      .insert(insertRow);
    if (insErr) throw insErr;
  }
}

/**
 * Reconcilia as órfãs com o pedido que apareceu DEPOIS (reconciliacao.ts tem o porquê). Só lê o
 * banco — o recebimento inteiro já está no raw_data da órfã — e por isso roda em todo run, mesmo o
 * `apenas_backfill`, sem custo de Omie. Roda ANTES do backfill: a linha de pedido que ganha a NF
 * aqui nasce com `nid_receb` nulo e o backfill do mesmo run já a completa.
 */
async function reconciliarOrfasEmpresa(
  supabase: SupabaseClient,
  empresa: Empresa,
  fornecedorCodigo: number | undefined,
  t0: number,
): Promise<ReconciliacaoSummary> {
  return await reconciliarOrfas(
    {
      listarOrfas: () =>
        fetchAll<OrfaParaReconciliar>((from, to) => {
          let q = supabase
            .from("purchase_orders_tracking")
            .select("id, fornecedor_codigo_omie, nfe_chave_acesso, raw_data")
            .eq("empresa", empresa)
            .lt("omie_codigo_pedido", 0)
            .not("nfe_chave_acesso", "is", null);
          if (fornecedorCodigo) q = q.eq("fornecedor_codigo_omie", fornecedorCodigo);
          // A ordem DECIDE: há pedido com 2 NFs órfãs (entrega parcial — 2 de 12 linhas em prod,
          // 2026-10-16). O CAS deixa a 1ª vencer; ordenar pela emissão faz vencer o 1º
          // FATURAMENTO (o t2 que o leadtime quer), e a 2ª conta em conflito_outra_nf. `id` desempata
          // e mantém a paginação estável.
          return q
            .order("t2_data_faturamento", { ascending: true, nullsFirst: false })
            .order("id")
            .range(from, to);
        }, "purchase_orders_tracking(órfãs)"),
      linhasDoPedido: (contrato, fornecedor) =>
        fetchAll<LinhaPedido>((from, to) =>
          supabase
            .from("purchase_orders_tracking")
            .select("id, status, t2_data_faturamento, t4_data_recebimento, nfe_chave_acesso")
            .eq("empresa", empresa)
            .eq("numero_contrato_fornecedor", contrato)
            .eq("fornecedor_codigo_omie", fornecedor)
            .gt("omie_codigo_pedido", 0)
            .order("id")
            .range(from, to), "purchase_orders_tracking(pedido do contrato)"),
      vincularSeSemNF: async (id, patch) => {
        const { data, error } = await supabase
          .from("purchase_orders_tracking")
          .update(patch)
          .eq("id", id)
          .is("nfe_chave_acesso", null)
          .select("id");
        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
      },
    },
    (raw) => mapNFe(raw as OmieConsultarRecebimentoResponse),
    {
      agoraIso: () => new Date().toISOString(),
      temTempo: () => Date.now() - t0 <= MAIN_LOOP_GUARD_MS,
      log: (msg) => console.warn(`[sync-nfes] ${empresa} ${msg}`),
    },
  );
}

// A sombra é uma FASE depois do vínculo, da reconciliação e do backfill de TODAS as empresas (Codex 2026-10-17, P1):
// não come o orçamento do trabalho prioritário. Só começa NF com folga ≥ 2 prazos (busca + publicação) antes do guard.
const SOMBRA_PRAZO_MS = 8_000;
const SOMBRA_FOLGA_MS = 2 * SOMBRA_PRAZO_MS + 1_000;

/** SKUs com equivalência de embalagem ativa (concentrados WP); `null` = não lido → toda NF da sombra fica ambígua. */
async function lerSkusComEquivalencia(supabase: SupabaseClient, empresa: Empresa): Promise<Set<string> | null> {
  try {
    const { data, error } = await supabase
      .from("sku_embalagem_equivalencia")
      .select("sku_codigo_omie")
      .eq("empresa", empresa.toLowerCase())
      .eq("ativo", true)
      .abortSignal(AbortSignal.timeout(SOMBRA_PRAZO_MS));
    if (error || !Array.isArray(data)) return null;
    return new Set(data.map((r) => String((r as { sku_codigo_omie: unknown }).sku_codigo_omie)));
  } catch {
    return null;
  }
}

function criarPortaSombra(supabase: SupabaseClient, empresa: Empresa): PortaSombra {
  return {
    async buscarPedidos(contratos, sinal) {
      const { data, error } = await supabase
        .from("purchase_orders_tracking")
        .select("omie_codigo_pedido, numero_pedido, fornecedor_codigo_omie, numero_contrato_fornecedor, raw_data")
        .eq("empresa", empresa)
        .gt("omie_codigo_pedido", 0)
        .in("numero_contrato_fornecedor", contratos)
        .order("omie_codigo_pedido")
        .range(0, 999)
        .abortSignal(sinal ?? AbortSignal.timeout(SOMBRA_PRAZO_MS));
      if (error) throw new Error(`POs dos contratos: ${error.message}`);
      if ((data ?? []).length >= 1000) throw new Error("POs dos contratos: 1000+ linhas (capa do PostgREST)");
      const out = new Map<string, PedidoDoContrato[]>();
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const raw = (r.raw_data ?? {}) as { cabecalho_consulta?: { nCodPed?: unknown; cEtapa?: unknown }; produtos_consulta?: unknown };
        // raw_data é multi-writer (o backfill de NF já gravou o RECEBIMENTO ali): só vale o documento do PRÓPRIO PO.
        const doPO = Number(raw.cabecalho_consulta?.nCodPed) === Number(r.omie_codigo_pedido);
        const contrato = String(r.numero_contrato_fornecedor);
        const lista = out.get(contrato) ?? [];
        lista.push({
          omie_codigo_pedido: Number(r.omie_codigo_pedido),
          numero_pedido: (r.numero_pedido as string | null) ?? null,
          fornecedor_codigo_omie: r.fornecedor_codigo_omie == null ? null : Number(r.fornecedor_codigo_omie),
          etapa: doPO && (typeof raw.cabecalho_consulta?.cEtapa === "string" || typeof raw.cabecalho_consulta?.cEtapa === "number")
            ? String(raw.cabecalho_consulta.cEtapa).trim() : null,
          itens: doPO && Array.isArray(raw.produtos_consulta) ? raw.produtos_consulta as PedidoDoContrato["itens"] : undefined,
        });
        out.set(contrato, lista);
      }
      return out;
    },
    async publicar(linha) {
      const { data, error } = await supabase
        .rpc("recebimento_associacao_sombra_publicar", { p: linha })
        .abortSignal(AbortSignal.timeout(SOMBRA_PRAZO_MS));
      if (error) throw new Error(`publicar: ${error.message}`);
      return String(data);
    },
  };
}

async function syncEmpresa(
  supabase: SupabaseClient,
  empresa: Empresa,
  dias: number,
  fornecedorCodigo: number | undefined,
  t0: number,
  filaSombra: ItemFilaSombra[],
  /** Preenchido aqui: a revisita do mesmo run não repete a consulta (seria REDUNDANT na Omie). */
  processadasNoRun: Set<number>,
  dataInicialOverride?: string,
  dataFinalOverride?: string,
): Promise<EmpresaSummary> {
  // Deadline do loop PRINCIPAL, derivado do MESMO t0 e do MESMO guard que o laço já consulta —
  // não é um relógio novo, é o guard existente ficando visível para o request e para o backoff.
  const deadline = t0 + MAIN_LOOP_GUARD_MS;
  const summary: EmpresaSummary & ContagemModelo = {
    empresa,
    nfes_processadas: 0,
    consultas_detalhadas: 0,
    pedidos_vinculados: 0,
    nfes_com_multiplos_pedidos: 0,
    nfes_orfas: 0,
    vinculos_criados_total: 0,
    erros: 0,
    documentos_listados: 0,
    ctes_ignorados: 0,
    modelo_divergente: 0,
    modelo_ausente: 0,
  };

  const { app_key, app_secret } = getCredentials(empresa);

  let dataDe: string;
  let dataAte: string;
  if (dataInicialOverride && dataFinalOverride) {
    dataDe = dataInicialOverride;
    dataAte = dataFinalOverride;
  } else {
    ({ dataDe, dataAte } = janelaDeDias(dias));
  }
  console.log(`[sync-nfes] ${empresa} janela ${dataDe} → ${dataAte}`);


  let pagina = 1;
  let totalPaginas = 1;
  let interrompidoPorTempo = false;

  while (pagina <= totalPaginas) {
    if (Date.now() - t0 > MAIN_LOOP_GUARD_MS) {
      console.warn(`[sync-nfes] ${empresa} MAIN_LOOP_GUARD na pág ${pagina} — interrompido p/ garantir completeSync`);
      interrompidoPorTempo = true;
      break;
    }
    let resp: OmieListRecebimentosResponse;
    try {
      const param: Record<string, unknown> = {
        nPagina: pagina,
        nRegistrosPorPagina: PAGE_SIZE,
        cOrdenarPor: "CODIGO",
        dtEmissaoDe: dataDe,
        dtEmissaoAte: dataAte,
        cExibirDetalhes: "S",
        cEtapa: "",
      };
      if (fornecedorCodigo) param.nIdFornecedor = fornecedorCodigo;
      resp = (await callOmie(app_key, app_secret, "ListarRecebimentos", param, deadline)) as OmieListRecebimentosResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-nfes] ${empresa} pag=${pagina} ListarRecebimentos erro: ${msg}`);
      summary.erros++;
      break;
    }

    if (resp?.faultstring) {
      const fs = String(resp.faultstring);
      // A Omie diz "acabou" por fault ("Não existem registros para a página"). Na página 1 é a janela
      // vazia — fim, não erro (antes virava `error` e alerta falso); numa página > 1 é anomalia e
      // segue erro visível (listagem.ts).
      if (ehFimDaListagem(fs, pagina)) {
        console.log(`[sync-nfes] ${empresa} pag=${pagina} sem resultados — fim`);
        break;
      }
      console.error(`[sync-nfes] ${empresa} pag=${pagina} faultstring: ${fs}`);
      summary.erros++;
      break;
    }

    totalPaginas = Number(resp?.nTotalPaginas ?? 1);
    const nfes: OmieNFeListItem[] = Array.isArray(resp?.recebimentos) ? resp.recebimentos : [];
    console.log(`[sync-nfes] ${empresa} pag=${pagina}/${totalPaginas} nfes=${nfes.length}`);

    for (const nfe of nfes) {
      if (Date.now() - t0 > MAIN_LOOP_GUARD_MS) {
        console.warn(`[sync-nfes] ${empresa} MAIN_LOOP_GUARD no meio da pág ${pagina} — interrompido`);
        interrompidoPorTempo = true;
        break;
      }
      const nIdReceb = Number(nfe?.cabec?.nIdReceb ?? 0);
      if (!nIdReceb) {
        summary.erros++;
        continue;
      }
      if (processadasNoRun.has(nIdReceb)) continue;
      processadasNoRun.add(nIdReceb);
      summary.documentos_listados++;

      // CT-e (modelo 57) é o conhecimento de FRETE: sem item, sem pedido. Sai AQUI — antes do sono,
      // do ConsultarRecebimento e de toda escrita (updateLinhasDoPedido também escreve) —, e só
      // quando a chave CRUA e o `cModeloNFe` concordam. O argumento é o cabeçalho que a Omie
      // mandou, não o `m` do mapNFe: a chave dele já foi normalizada, e uma chave formatada viraria
      // evidência que ela não é. Divergência e ausência seguem o fluxo de NF-e, contadas à parte.
      // O `continue` não mexe na paginação: página só de CT-e avança para a seguinte.
      const modelo = classificarModeloRecebimento(nfe?.cabec);
      if (modelo.tipo === "cte") {
        summary.ctes_ignorados++;
        continue;
      }
      if (modelo.tipo === "divergente") {
        summary.modelo_divergente++;
        console.warn(`[sync-nfes] ${empresa} nIdReceb=${nIdReceb} modelo divergente: chave=${modelo.daChave} cabec=${modelo.doCabecalho} — segue como NF-e`);
      } else if (modelo.tipo === "ausente") {
        summary.modelo_ausente++;
        console.warn(`[sync-nfes] ${empresa} nIdReceb=${nIdReceb} modelo ilegível: chave=${modelo.daChave ?? "?"} cabec=${modelo.doCabecalho ?? "?"} — segue como NF-e`);
      }

      try {
        const m = mapNFe(nfe);
        if (!m.chave || !m.data_emissao_iso) {
          throw new Error(`NFe nIdReceb=${nIdReceb} sem chave ou dEmissaoNFe`);
        }

        // ConsultarRecebimento → busca itens e nNumPedCompra
        await sleep(RATE_LIMIT_DELAY_MS);
        let detalhe: OmieConsultarRecebimentoResponse;
        // Carimbo da TENTATIVA que produziu a resposta (Codex 2026-10-17): o de antes dos retries deixaria uma leitura
        // mais nova (cancelamento) perder o compare-and-set para uma mais velha.
        let detalheLidoEm = "";
        try {
          detalhe = (await callOmie(app_key, app_secret, "ConsultarRecebimento", { nIdReceb }, deadline, (t) => { detalheLidoEm = t; })) as OmieConsultarRecebimentoResponse;
        } catch (errDet) {
          const msgDet = errDet instanceof Error ? errDet.message : String(errDet);
          // Falha esgotada/transitória do ConsultarRecebimento NÃO prova ausência de
          // pedido. Gravar órfã aqui fabricaria dado FALSO (money-path): a NFe pode ter
          // pedido vinculado que só não pudemos ler agora. Marca erro e PULA — a NFe
          // volta no próximo run quando a Omie estabilizar.
          console.warn(`[sync-nfes] ${empresa} nIdReceb=${nIdReceb} ConsultarRecebimento exceção: ${msgDet} — pulando (NÃO vira órfã)`);
          summary.erros++;
          continue;
        }
        // A Omie também devolve erro de negócio como PAYLOAD (faultstring, HTTP 200, sem
        // exceção). Isso igualmente NÃO prova ausência de pedido → mesmo tratamento: pula,
        // não vira órfã. Espelha o guard do backfill (if !detalhe || detalhe?.faultstring).
        if (detalhe?.faultstring) {
          console.warn(`[sync-nfes] ${empresa} nIdReceb=${nIdReceb} ConsultarRecebimento faultstring: ${String(detalhe.faultstring)} — pulando (NÃO vira órfã)`);
          summary.erros++;
          continue;
        }
        summary.consultas_detalhadas++;

        const numerosPedido = extrairPedidosDoDetalhe(detalhe);

        if (numerosPedido.length >= 2) {
          console.log(
            `[sync-nfes] ${empresa} chave=${m.chave} nIdReceb=${nIdReceb} ` +
            `referencia ${numerosPedido.length} pedidos distintos: ${numerosPedido.join(", ")}`,
          );
        }

        let vinculadasNestaNFe = 0;
        let pedidosCasados = 0;
        for (const numPed of numerosPedido) {
          try {
            const n = await updateLinhasDoPedido(
              supabase, empresa, numPed, m.fornecedor_codigo, m,
            );
            vinculadasNestaNFe += n;
            summary.vinculos_criados_total += n;
            if (n > 0) pedidosCasados++;
          } catch (errUpd) {
            const msgU = errUpd instanceof Error ? errUpd.message : String(errUpd);
            console.error(`[sync-nfes] ${empresa} chave=${m.chave} numPed=${numPed} update erro: ${msgU}`);
            summary.erros++;
          }
        }

        if (vinculadasNestaNFe > 0) {
          summary.pedidos_vinculados++;
          if (pedidosCasados >= 2) summary.nfes_com_multiplos_pedidos++;
        } else {
          // Nenhum pedido casado por numero_contrato → órfã
          await insertOrfa(supabase, empresa, nfe, m, nIdReceb);
          summary.nfes_orfas++;
        }
        summary.nfes_processadas++;
        if (detalheLidoEm !== "") filaSombra.push({
          nf: { empresa, nIdReceb, numero_nfe: m.numero, chave_nfe: m.chave, fornecedor_codigo_omie: m.fornecedor_codigo },
          detalhe, observadoEm: detalheLidoEm,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-nfes] ${empresa} nIdReceb=${nIdReceb} chave=${nfe?.cabec?.cChaveNFe ?? nfe?.cabec?.cChaveNfe} erro: ${msg}`);
        summary.erros++;
      }
    }

    if (interrompidoPorTempo) break;

    pagina++;
    if (pagina <= totalPaginas) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  if (interrompidoPorTempo) summary.interrompido_por_timeout = true;

  return summary;
}

/**
 * Backfill: para NFes já existentes em purchase_orders_tracking que tenham
 * nfe_chave_acesso preenchida mas raw_data incompleto (sem cabec.nIdReceb),
 * chama ConsultarRecebimento(cChaveNFe) e atualiza raw_data + campos NULL.
 */
async function backfillRawData(
  supabase: SupabaseClient,
  empresa: Empresa,
  fornecedorCodigo: number | undefined,
  t0: number,
): Promise<BackfillSummary> {
  // O backfill roda DEPOIS do loop principal e cede mais tarde (130s, não 120s) — por isso o
  // deadline daqui é o TIMEOUT_GUARD_MS, o mesmo que o guard desta função já usa.
  const deadline = t0 + TIMEOUT_GUARD_MS;
  const out: BackfillSummary = {
    nfes_identificadas_para_backfill: 0,
    nfes_backfilled: 0,
    nfes_pulou_por_timeout: 0,
    erros: 0,
  };

  const { app_key, app_secret } = getCredentials(empresa);

  // O pendente é decidido pela COLUNA DEDICADA, no BANCO — não pelo jsonb, em memória.
  // Por quê: raw_data é multi-writer (o sync de pedidos o sobrescreve com o payload do
  // PEDIDO), então filtrar por ele redescobria como "pendente" toda linha que este mesmo
  // backfill já havia resolvido na rodada anterior — o contador de identificadas ficava
  // travado por dias enquanto a Omie era consultada à toa. nid_receb sobrevive ao sync
  // concorrente (está no PRESERVE_FIELDS dele), então o trabalho ACUMULA e a fila drena.
  // Filtrar no banco também tira a lista inteira da memória — o teto de 1.000 linhas do
  // PostgREST truncava em silêncio conforme a tabela crescesse.
  let q = supabase
    .from("purchase_orders_tracking")
    .select("id, nfe_chave_acesso, raw_data, nid_receb, t2_data_faturamento, t4_data_recebimento, transportadora_nome, transportadora_cnpj")
    .eq("empresa", empresa)
    .not("nfe_chave_acesso", "is", null)
    .is("nid_receb", null);
  if (fornecedorCodigo) q = q.eq("fornecedor_codigo_omie", fornecedorCodigo);

  const { data: linhas, error: selErr } = await q;
  if (selErr) {
    console.error(`[backfill] ${empresa} select erro: ${selErr.message}`);
    out.erros++;
    return out;
  }

  const incompletos = (linhas ?? []) as PurchaseOrderTrackingRow[];

  out.nfes_identificadas_para_backfill = incompletos.length;
  console.log(`[backfill] ${empresa} identificadas=${incompletos.length}`);

  for (const linha of incompletos) {
    if (Date.now() - t0 > TIMEOUT_GUARD_MS) {
      out.nfes_pulou_por_timeout = incompletos.length - (out.nfes_backfilled + out.erros);
      console.warn(`[backfill] ${empresa} TIMEOUT GUARD — interrompido. Pendentes=${out.nfes_pulou_por_timeout}`);
      break;
    }

    const chave = String(linha.nfe_chave_acesso ?? "").replace(/\D/g, "").slice(0, 44);
    if (chave.length !== 44) {
      out.erros++;
      continue;
    }

    try {
      await sleep(RATE_LIMIT_DELAY_MS);
      const detalhe = (await callOmie(app_key, app_secret, "ConsultarRecebimento", { cChaveNFe: chave }, deadline)) as OmieConsultarRecebimentoResponse;

      if (!detalhe || detalhe?.faultstring) {
        const fs = String(detalhe?.faultstring ?? "vazio");
        console.warn(`[backfill] ${empresa} chave=${chave} sem detalhe: ${fs}`);
        out.erros++;
        continue;
      }

      const m = mapNFe(detalhe);
      const updateRow: Record<string, unknown> = {
        // Dual-write: a coluna dedicada é a fonte de verdade daqui pra frente, mas o
        // raw_data segue sendo gravado enquanto houver leitor legado do jsonb.
        raw_data: detalhe,
        updated_at: new Date().toISOString(),
      };

      // Sinal money-path: só entra se for numérico. Ausente/ilegível ⇒ deixa NULL — um
      // nIdReceb fabricado consultaria o recebimento ERRADO no ERP (ausente ≠ zero).
      const nidBruto = detalhe?.cabec?.nIdReceb;
      const nid = typeof nidBruto === "number"
        ? nidBruto
        : (typeof nidBruto === "string" && /^\d+$/.test(nidBruto) ? Number(nidBruto) : null);
      if (nid !== null) updateRow.nid_receb = nid;
      if (!linha.t2_data_faturamento && m.data_emissao_iso) {
        updateRow.t2_data_faturamento = m.data_emissao_iso;
      }
      if (!linha.t4_data_recebimento && m.recebida && m.data_recebimento_iso) {
        updateRow.t4_data_recebimento = m.data_recebimento_iso;
      }
      if (!linha.transportadora_nome && m.transp_nome) {
        updateRow.transportadora_nome = m.transp_nome;
      }
      if (!linha.transportadora_cnpj && m.transp_cnpj) {
        updateRow.transportadora_cnpj = m.transp_cnpj;
      }

      // Compare-and-set: só grava se o sinal ainda estiver ausente E a chave da linha for
      // a MESMA que foi consultada. Sem isto, dois runs concorrentes (ou uma chave trocada
      // no meio da chamada à Omie) poderiam carimbar nesta linha o recebimento de outra
      // NFe. Perder a corrida é inócuo — quem venceu já gravou o mesmo sinal.
      const { error: updErr } = await supabase
        .from("purchase_orders_tracking")
        .update(updateRow)
        .eq("id", linha.id)
        .eq("nfe_chave_acesso", linha.nfe_chave_acesso)
        .is("nid_receb", null);
      if (updErr) {
        console.error(`[backfill] ${empresa} chave=${chave} update erro: ${updErr.message}`);
        out.erros++;
        continue;
      }
      out.nfes_backfilled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] ${empresa} chave=${chave} erro: ${msg}`);
      out.erros++;
      if (/rate limit|425|429/i.test(msg)) {
        const restantes = incompletos.length - (out.nfes_backfilled + out.erros);
        if (restantes > 0) {
          out.nfes_pulou_por_timeout += restantes;
          console.warn(`[backfill] ${empresa} aborto por rate limit. Pendentes=${restantes}`);
        }
        break;
      }
    }
  }

  console.log(`[backfill] ${empresa} backfilled=${out.nfes_backfilled} erros=${out.erros} pulou=${out.nfes_pulou_por_timeout}`);
  return out;
}

// Revisita (revisita.ts): teto de páginas da listagem larga — 30 dias OBEN são ~2 páginas de 50 (medido
// 2026-10-18); o teto só impede um laço sem fim se a Omie insistir em página cheia.
const REVISITA_MAX_PAGINAS = 20;
const REVISITA_LOTE_CONHECIDAS = 50;

/** nIdReceb que o banco já conhece: pela chave, pelo `nid_receb` da linha ou como órfã (`-nIdReceb`). */
async function nidsConhecidos(
  supabase: SupabaseClient,
  empresa: Empresa,
  docs: Array<{ nIdReceb: number; chave: string }>,
): Promise<Set<number>> {
  const out = new Set<number>();
  for (let i = 0; i < docs.length; i += REVISITA_LOTE_CONHECIDAS) {
    const lote = docs.slice(i, i + REVISITA_LOTE_CONHECIDAS);
    const nidPorChave = new Map(lote.map((d) => [d.chave, d.nIdReceb]));
    const nids = lote.map((d) => d.nIdReceb);
    const base = () => supabase.from("purchase_orders_tracking");
    const [porChave, porNid, porOrfa] = await Promise.all([
      fetchAll<{ nfe_chave_acesso: string | null }>((from, to) =>
        base().select("nfe_chave_acesso").eq("empresa", empresa).in("nfe_chave_acesso", [...nidPorChave.keys()])
          .order("id").range(from, to), "purchase_orders_tracking(revisita:chave)"),
      fetchAll<{ nid_receb: number | null }>((from, to) =>
        base().select("nid_receb").eq("empresa", empresa).in("nid_receb", nids)
          .order("id").range(from, to), "purchase_orders_tracking(revisita:nid)"),
      fetchAll<{ omie_codigo_pedido: number }>((from, to) =>
        base().select("omie_codigo_pedido").eq("empresa", empresa).in("omie_codigo_pedido", nids.map((n) => -n))
          .order("id").range(from, to), "purchase_orders_tracking(revisita:orfa)"),
    ]);
    for (const r of porChave) {
      const nid = r.nfe_chave_acesso ? nidPorChave.get(r.nfe_chave_acesso) : undefined;
      if (nid !== undefined) out.add(nid);
    }
    for (const r of porNid) if (r.nid_receb != null) out.add(Number(r.nid_receb));
    for (const r of porOrfa) out.add(-Number(r.omie_codigo_pedido));
  }
  return out;
}

/**
 * Lista a janela larga inteira ANTES de processar (a revisita ordena por emissão). Não confia no total
 * declarado (listagem.ts). Falha no meio devolve o que já veio com `incompleta`: a revisita só preenche
 * e nada conclui por ausência, então o parcial é seguro — e fica visível.
 */
async function listarJanelaLarga(
  empresa: Empresa,
  dataDe: string,
  dataAte: string,
  fornecedorCodigo: number | undefined,
  deadline: number,
): Promise<{ docs: DocumentoRevisita[]; incompleta: boolean }> {
  const { app_key, app_secret } = getCredentials(empresa);
  const docs: DocumentoRevisita[] = [];
  let totalDeclarado = 1;
  for (let pagina = 1; pagina <= REVISITA_MAX_PAGINAS; pagina++) {
    if (Date.now() >= deadline) return { docs, incompleta: true };
    if (pagina > 1) await sleep(RATE_LIMIT_DELAY_MS);
    const param: Record<string, unknown> = {
      nPagina: pagina,
      nRegistrosPorPagina: PAGE_SIZE,
      cOrdenarPor: "CODIGO",
      dtEmissaoDe: dataDe,
      dtEmissaoAte: dataAte,
      cExibirDetalhes: "S",
      cEtapa: "",
    };
    if (fornecedorCodigo) param.nIdFornecedor = fornecedorCodigo;
    let resp: OmieListRecebimentosResponse;
    try {
      resp = (await callOmie(app_key, app_secret, "ListarRecebimentos", param, deadline)) as OmieListRecebimentosResponse;
    } catch (err) {
      console.error(`[revisita] ${empresa} pag=${pagina} ListarRecebimentos erro: ${mensagemDeErro(err) ?? "erro sem mensagem"}`);
      return { docs, incompleta: true };
    }
    if (resp?.faultstring) {
      const fs = String(resp.faultstring);
      if (ehFimDaListagemLarga(fs, pagina, totalDeclarado)) return { docs, incompleta: false };
      console.error(`[revisita] ${empresa} pag=${pagina} faultstring: ${fs}`);
      return { docs, incompleta: true };
    }
    const declarado = Number(resp?.nTotalPaginas);
    if (Number.isFinite(declarado) && declarado > totalDeclarado) totalDeclarado = declarado;
    const itens: OmieNFeListItem[] = Array.isArray(resp?.recebimentos) ? resp.recebimentos : [];
    for (const nfe of itens) {
      const m = mapNFe(nfe);
      docs.push({
        nIdReceb: Number(nfe?.cabec?.nIdReceb ?? 0),
        chave: m.chave && m.chave.length === 44 ? m.chave : null,
        fornecedor: m.fornecedor_codigo,
        emissaoIso: m.data_emissao_iso,
        cte: classificarModeloRecebimento(nfe?.cabec).tipo === "cte",
        cancelada: m.cancelada,
        bruto: nfe,
      });
    }
    if (!pedirProximaPaginaLarga(pagina, totalDeclarado, itens.length, PAGE_SIZE)) return { docs, incompleta: false };
  }
  console.warn(`[revisita] ${empresa} teto de ${REVISITA_MAX_PAGINAS} páginas atingido — listagem incompleta`);
  return { docs, incompleta: true };
}

async function revisitarEmpresa(
  supabase: SupabaseClient,
  empresa: Empresa,
  dias: number,
  fornecedorCodigo: number | undefined,
  t0: number,
  processadasNoRun: ReadonlySet<number>,
  out: RevisitaSummary,
): Promise<void> {
  // Mesmo orçamento do laço principal (o guard que o run já respeita): a revisita só usa a sobra.
  const deadline = t0 + MAIN_LOOP_GUARD_MS;
  const { dataDe, dataAte } = janelaDeDias(dias);
  const { docs, incompleta } = await listarJanelaLarga(empresa, dataDe, dataAte, fornecedorCodigo, deadline);
  if (incompleta) out.listagem_incompleta = true;
  const { app_key, app_secret } = getCredentials(empresa);

  const porta: PortaRevisita = {
    conhecidas: (lista) => nidsConhecidos(supabase, empresa, lista),
    async consultar(nIdReceb) {
      await sleep(RATE_LIMIT_DELAY_MS);
      const det = (await callOmie(app_key, app_secret, "ConsultarRecebimento", { nIdReceb }, deadline)) as OmieConsultarRecebimentoResponse;
      if (!det || det.faultstring) throw new Error(`ConsultarRecebimento faultstring: ${String(det?.faultstring ?? "vazio")}`);
      return det;
    },
    inserirOrfa: (d) => insertOrfa(supabase, empresa, d.bruto as OmieNFeListItem, mapNFe(d.bruto as OmieNFeListItem), d.nIdReceb),
    linhasDoPedido: (contrato, fornecedor) =>
      fetchAll<LinhaPedido>((from, to) =>
        supabase
          .from("purchase_orders_tracking")
          .select("id, status, t2_data_faturamento, t4_data_recebimento, nfe_chave_acesso")
          .eq("empresa", empresa)
          .eq("numero_contrato_fornecedor", contrato)
          .eq("fornecedor_codigo_omie", fornecedor)
          .gt("omie_codigo_pedido", 0)
          .order("id")
          .range(from, to), "purchase_orders_tracking(revisita:pedido do contrato)"),
    vincularSeSemNF: async (id, patch) => {
      const { data, error } = await supabase
        .from("purchase_orders_tracking")
        .update(patch)
        .eq("id", id)
        .is("nfe_chave_acesso", null)
        .select("id");
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },
  };

  await revisitarJanela(docs, processadasNoRun, porta, (raw) => mapNFe(raw as OmieConsultarRecebimentoResponse), {
    agoraIso: () => new Date().toISOString(),
    temTempo: () => Date.now() < deadline,
    log: (msg) => console.warn(`[sync-nfes] ${empresa} ${msg}`),
  }, out);
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
// senão COLACOR) → companies em minúsculo, sempre no conjunto que o watchdog varre.
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
      console.error("[sync-nfes] logSync erro PostgREST (segue sem log):", error.message);
      return "";
    }
    return (data as { id?: string } | null)?.id ?? "";
  } catch (e) {
    console.error("[sync-nfes] logSync exceção (segue sem log):", e instanceof Error ? e.message : e);
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
      // Não dá pra recuperar aqui, mas registra a causa nos logs da edge.
      console.error("[sync-nfes] completeSync erro PostgREST (linha fica 'running'):", error.message);
    }
  } catch (e) {
    console.error("[sync-nfes] completeSync exceção (best-effort):", e instanceof Error ? e.message : e);
  }
}

// `versao` em TODA resposta (sucesso e erro), não só na da sonda: a pergunta "essa correção
// subiu?" quase sempre é feita sobre um run que JÁ aconteceu — e o caso que mais importa é o do
// run que morreu no meio da varredura.
function jsonRes(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...body, versao: VERSAO, edge: EDGE, fonte: FONTE }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    // Sonda de deploy por cron (F4, onda 4). Só responde com a credencial HMAC válida; sem
    // ela o preflight do browser recebe a mesma resposta de sempre, byte a byte.
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response(null, { headers: corsHeaders });
  }
  if (!(await authorizeCronOrStaff(req))) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  // ⚠️ SONDA DE VERSÃO — logo após o gate (que já aceita x-cron-secret) e ANTES do createClient,
  // da varredura no Omie e de qualquer escrita. O parse do corpo SUBIU para cá de propósito: no
  // desenho anterior ele vinha depois do `createClient`, e a sonda ali já teria custo.
  // Daqui pra frente a edge reescreve `purchase_orders_tracking` e abre linha em `fin_sync_log`,
  // que o cálculo de frescor lê sem filtrar `action` — sondar de graça exige responder antes.
  // req.json() é one-shot: o corpo lido aqui é reaproveitado no fluxo real abaixo.
  // Ver versao.ts / _shared/sonda-versao.ts.
  let corpoBruto: unknown = {};
  if (req.method === "POST") {
    try { corpoBruto = await req.json(); } catch { corpoBruto = {}; }
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return jsonRes(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return jsonRes({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const t0 = Date.now();
  // cron = x-cron-secret (cron diário direto) OU service-role (via orquestrador omie-cron-diario,
  // que chama as edges com Bearer SERVICE_ROLE, sem repassar o x-cron-secret). user JWT (staff) = manual.
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const triggeredBy = (req.headers.get("x-cron-secret") ||
    (svcKey && req.headers.get("Authorization") === `Bearer ${svcKey}`)) ? "cron" : "manual";

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonRes({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Corpo já consumido no bloco da sonda acima (req.json() é one-shot). Não-objeto vira {} —
    // cai nos mesmos defaults de antes (empresa "ALL", dias 30).
    const body: RequestBody =
      typeof corpoBruto === "object" && corpoBruto !== null && !Array.isArray(corpoBruto)
        ? corpoBruto as RequestBody
        : {};

    const empresaParam = (body.empresa ?? "ALL").toUpperCase() as "OBEN" | "COLACOR" | "ALL";
    const dias = typeof body.dias === "number" && body.dias > 0 ? body.dias : 30;
    const fornecedorCodigo = body.fornecedor_codigo_omie;
    const dataInicial = typeof body.data_inicial === "string" ? body.data_inicial : undefined;
    const dataFinal = typeof body.data_final === "string" ? body.data_final : undefined;
    const apenasBackfill = body.apenas_backfill === true;
    const pularBackfill = body.pular_backfill === true;
    const revisitaDias = apenasBackfill ? null : lerRevisitaDias(body.revisita_dias);

    const empresas: Empresa[] =
      empresaParam === "ALL" ? ["OBEN", "COLACOR"] : [empresaParam as Empresa];

    console.log(`[sync-nfes] início empresas=${empresas.join(",")} dias=${dias} janela=${dataInicial ?? "-"}→${dataFinal ?? "-"} fornecedor=${fornecedorCodigo ?? "todos"} apenas_backfill=${apenasBackfill} pular_backfill=${pularBackfill}`);

    const summary: EmpresaSummary[] = [];
    const filasSombra = new Map<Empresa, { s: EmpresaSummary; fila: ItemFilaSombra[] }>();
    const processadasPorEmpresa = new Map<Empresa, Set<number>>();
    const sombraTemTempo = () => Date.now() - t0 < MAIN_LOOP_GUARD_MS - SOMBRA_FOLGA_MS;
    const aConcluir: Array<{ empLogId: Awaited<ReturnType<typeof logSync>>; s: EmpresaSummary; falha: string | undefined }> = [];
    // O finally conclui TODA empresa que terminou com sucesso, mesmo se algo lançar depois dela (outra empresa, a sombra).
    try {
    for (const empresa of empresas) {
      const empLogId = await logSync(supabase, "sync_nfes_recebidas", [empresaParaLog(empresa)], triggeredBy);
      try {
        let s: EmpresaSummary;
        if (apenasBackfill) {
          s = {
            empresa,
            nfes_processadas: 0,
            consultas_detalhadas: 0,
            pedidos_vinculados: 0,
            nfes_com_multiplos_pedidos: 0,
            nfes_orfas: 0,
            vinculos_criados_total: 0,
            erros: 0,
          };
        } else {
          const fila: ItemFilaSombra[] = [];
          const processadas = new Set<number>();
          processadasPorEmpresa.set(empresa, processadas);
          s = await syncEmpresa(supabase, empresa, dias, fornecedorCodigo, t0, fila, processadas, dataInicial, dataFinal);
          filasSombra.set(empresa, { s, fila });
          // Documento dos POs capturado ANTES do backfill, que troca o raw_data do PO pelo recebimento (Codex 2026-10-17).
          await capturarPedidosDaFila(fila, criarPortaSombra(supabase, empresa), sombraTemTempo, SOMBRA_PRAZO_MS);
          console.log(
            `[sync-nfes] ${empresa} TOTAL: nfes=${s.nfes_processadas} ` +
            `consultas=${s.consultas_detalhadas} vinculadas=${s.pedidos_vinculados} ` +
            `multi=${s.nfes_com_multiplos_pedidos} orfas=${s.nfes_orfas} ` +
            `vinculos=${s.vinculos_criados_total} erros=${s.erros} listados=${s.documentos_listados} ` +
            `ctes_ignorados=${s.ctes_ignorados} modelo_div=${s.modelo_divergente} ` +
            `modelo_aus=${s.modelo_ausente} dur=${Date.now() - t0}ms`,
          );
        }

        // Se o loop principal já estourou o guard de tempo, PULA o backfill: ele só
        // consumiria a margem que resta p/ o completeSync rodar (senão a linha fica
        // 'running' órfã). O backfill retroativo pega no próximo ciclo.
        if (s.interrompido_por_timeout && !pularBackfill) {
          console.warn(`[sync-nfes] ${empresa} main loop interrompido por tempo — pulando backfill p/ garantir completeSync`);
        }
        if (!s.interrompido_por_timeout) {
          // Falha aqui NÃO derruba o run nem o backfill: a órfã fica como estava (nada foi
          // fabricado) e o próximo run tenta de novo. O erro fica VISÍVEL no results.
          try {
            const rc = await reconciliarOrfasEmpresa(supabase, empresa, fornecedorCodigo, t0);
            s.reconciliacao = rc;
            console.log(
              `[sync-nfes] ${empresa} reconcilia: orfas=${rc.orfas_lidas} casadas=${rc.orfas_com_pedido} ` +
              `vinculadas=${rc.linhas_vinculadas} ja=${rc.ja_vinculadas} conflito=${rc.conflito_outra_nf} ` +
              `corrida=${rc.corrida_perdida} puladas=${rc.orfas_puladas} erros=${rc.erros}`,
            );
            if (rc.interrompido_por_timeout) s.interrompido_por_timeout = true;
          } catch (errRc) {
            const msgRc = mensagemDeErro(errRc) ?? "erro sem mensagem";
            console.error(`[sync-nfes] ${empresa} reconciliação erro fatal: ${msgRc}`);
            s.erros++;
          }
        }
        if (!pularBackfill && !s.interrompido_por_timeout) {
          try {
            const bf = await backfillRawData(supabase, empresa, fornecedorCodigo, t0);
            s.backfill = bf;
            if (bf.nfes_pulou_por_timeout > 0) s.interrompido_por_timeout = true;
          } catch (errBf) {
            const msgBf = errBf instanceof Error ? errBf.message : String(errBf);
            console.error(`[sync-nfes] ${empresa} backfill erro fatal: ${msgBf}`);
            s.backfill = {
              nfes_identificadas_para_backfill: 0,
              nfes_backfilled: 0,
              nfes_pulou_por_timeout: 0,
              erros: 1,
            };
          }
        }

        summary.push(s);
        // Rate-limit/Omie TOTAL (0 NFes processadas COM erro) é falha real, não "nada
        // novo" → marca 'error' p/ o Sentinela ver; erro PARCIAL fica em results (complete).
        const falhaSistemica = s.erros > 0 && s.nfes_processadas === 0
          ? `0 NFes processadas com ${s.erros} erro(s) — rate-limit/Omie?`
          : undefined;
        // Sucesso: o completeSync espera a fase da sombra (abaixo) para levar o resumo dela no results.
        aConcluir.push({ empLogId, s, falha: falhaSistemica });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-nfes] ${empresa} erro fatal: ${msg}`);
        await completeSync(supabase, empLogId, {}, msg, Date.now() - t0);
        summary.push({
          empresa,
          nfes_processadas: 0,
          consultas_detalhadas: 0,
          pedidos_vinculados: 0,
          nfes_com_multiplos_pedidos: 0,
          nfes_orfas: 0,
          vinculos_criados_total: 0,
          erros: 1,
        });
      }
    }

    // Fase da sombra da associação NF↔PO (sombra.ts): nada vai ao Omie, depois de TODO o trabalho prioritário.
    try {
      for (const [empresa, { s, fila }] of filasSombra) {
        if (!aConcluir.some((c) => c.s === s)) continue;
        const r = novaSombraSummary();
        s.sombra = r;
        await executarFaseSombra(fila, criarPortaSombra(supabase, empresa), () => lerSkusComEquivalencia(supabase, empresa), sombraTemTempo, r);
      }
    } catch (errSombra) {
      console.error(`[sync-nfes] fase da sombra erro (o vínculo segue): ${mensagemDeErro(errSombra) ?? "erro sem mensagem"}`);
    }

    // Revisita da janela larga (revisita.ts): a ÚLTIMA fase, com a sobra do orçamento — o trabalho prioritário
    // (janela de 3 dias, reconciliação, backfill, sombra) já rodou. Só para a empresa que concluiu com sucesso.
    if (revisitaDias !== null) {
      for (const c of aConcluir) {
        const r = novaRevisitaSummary(revisitaDias);
        c.s.revisita = r;
        try {
          await revisitarEmpresa(supabase, c.s.empresa, revisitaDias, fornecedorCodigo, t0, processadasPorEmpresa.get(c.s.empresa) ?? new Set(), r);
          console.log(
            `[sync-nfes] ${c.s.empresa} revisita ${revisitaDias}d: listados=${r.documentos_listados} conhecidas=${r.conhecidas} ` +
            `desconhecidas=${r.desconhecidas} consultadas=${r.consultadas} vinculadas=${r.linhas_vinculadas} ja=${r.ja_vinculadas} ` +
            `conflito=${r.conflito_outra_nf} orfas=${r.orfas_inseridas} tempo=${r.puladas_por_tempo} erros=${r.erros} ` +
            `incompleta=${r.listagem_incompleta === true}`,
          );
        } catch (errRv) {
          r.erros++;
          console.error(`[sync-nfes] ${c.s.empresa} revisita erro (o run segue): ${mensagemDeErro(errRv) ?? "erro sem mensagem"}`);
        }
      }
    }
    } finally {
      for (const c of aConcluir) {
        try {
          await completeSync(supabase, c.empLogId, c.s as unknown as Record<string, unknown>, c.falha, Date.now() - t0);
        } catch (errCs) {
          console.error(`[sync-nfes] ${c.s.empresa} completeSync erro: ${mensagemDeErro(errCs) ?? "erro sem mensagem"}`);
        }
      }
    }

    return jsonRes({ ok: true, duracao_ms: Date.now() - t0, summary }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync-nfes] erro fatal:", msg);
    return jsonRes({ ok: false, error: msg, duracao_ms: Date.now() - t0 }, 500);
  }
});
