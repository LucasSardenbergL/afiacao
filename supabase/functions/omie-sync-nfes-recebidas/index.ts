// Edge Function: omie-sync-nfes-recebidas
// Sincroniza NFes de entrada (recebidas) do Omie (Oben + Colacor) para purchase_orders_tracking.
// Pública (verify_jwt = false) — acionada via POST manual ou cron.
//
// Métodos Omie usados (endpoint /api/v1/produtos/recebimentonfe/):
//   - ListarRecebimentos  → lista NFes do período (cabec + infoCadastro)
//   - ConsultarRecebimento → detalha 1 NFe e traz itensRecebimento[].itensInfoAdic.nNumPedCompra
//
// Estratégia de vínculo NFe ↔ Pedido:
//   1) Lista NFes do período via ListarRecebimentos.
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

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { classifyOmieResponse, computeBackoffMs } from "./retry.ts";

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
}

interface BackfillSummary {
  nfes_identificadas_para_backfill: number;
  nfes_backfilled: number;
  nfes_pulou_por_timeout: number;
  erros: number;
}

interface EmpresaSummary {
  empresa: Empresa;
  nfes_processadas: number;
  consultas_detalhadas: number;       // quantas ConsultarRecebimento rodaram com sucesso
  pedidos_vinculados: number;         // NFes que casaram com 1+ pedido real
  nfes_com_multiplos_pedidos: number; // NFes que referenciaram 2+ pedidos distintos
  nfes_orfas: number;                 // NFes inseridas como órfãs
  vinculos_criados_total: number;     // soma de UPDATEs em linhas de pedido (NFe×pedido)
  erros: number;
  interrompido_por_timeout?: boolean;
  backfill?: BackfillSummary;
}

const TIMEOUT_GUARD_MS = 130_000;
// Guard do loop PRINCIPAL (syncEmpresa). Com retry em transitório, o loop pode
// consumir toda a janela e deixar a linha fin_sync_log 'running' órfã (sem
// completeSync). Cede ANTES do backfill (130s) p/ sobrar tempo ao completeSync.
const MAIN_LOOP_GUARD_MS = 120_000;

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
): Promise<OmieGenericResponse> {
  const body = { call, app_key, app_secret, param: [param] };

  // Retry alinhado às edges irmãs (omie-vendas-sync): retenta rate-limit E
  // transitório da Omie (SOAP-ERROR/Application Server/timeout) E HTTP 5xx, com
  // backoff. 4xx (não-429) falha alto. Após esgotar, LANÇA (OMIE_TRANSIENT) —
  // nunca devolve faultstring transitório ao caller, senão o syncEmpresa o leria
  // como erro de negócio e abortaria a página (o incidente OBEN de 05/07).
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(OMIE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: OmieGenericResponse;
    try { json = JSON.parse(text) as OmieGenericResponse; } catch { json = { raw: text }; }

    const fs = json?.faultstring ? String(json.faultstring) : undefined;
    const verdict = classifyOmieResponse(res.status, fs);

    if (verdict.kind === "retry") {
      if (attempt < MAX_RETRIES) {
        const delay = computeBackoffMs(fs ?? "", attempt);
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
 * Extrai a lista deduplicada de nNumPedCompra (CNUMERO do pedido de compra)
 * a partir de itensRecebimento[].itensInfoAdic.nNumPedCompra do detalhe da NFe.
 */
function extractPedidosFromDetalhe(detalhe: OmieConsultarRecebimentoResponse | null): string[] {
  const itens: OmieItemRecebimento[] = Array.isArray(detalhe?.itensRecebimento) ? detalhe.itensRecebimento : [];
  const set = new Set<string>();
  for (const it of itens) {
    const adic: OmieItensInfoAdic = it?.itensInfoAdic ?? {};
    const num = adic?.nNumPedCompra;
    if (num !== undefined && num !== null && String(num).trim() !== "" && String(num).trim() !== "0") {
      set.add(String(num).trim());
    }
  }
  return Array.from(set);
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
  const linhas = (data ?? []) as PurchaseOrderTrackingRow[];
  if (linhas.length === 0) return 0;

  let atualizadas = 0;
  for (const linha of linhas) {
    const currentStatus = String(linha.status ?? "");
    let finalStatus: "FATURADO" | "RECEBIDO" | "CANCELADO" = m.status;
    if (currentStatus === "CANCELADO") finalStatus = "CANCELADO";
    else if (currentStatus === "RECEBIDO" && m.status === "FATURADO") finalStatus = "RECEBIDO";

    const updateRow: Record<string, unknown> = {
      t2_data_faturamento: linha.t2_data_faturamento ?? m.data_emissao_iso,
      nfe_chave_acesso: m.chave,
      nfe_numero: m.numero,
      nfe_serie: m.serie,
      status: finalStatus,
      updated_at: new Date().toISOString(),
    };
    if (m.recebida && m.data_recebimento_iso) {
      updateRow.t4_data_recebimento = linha.t4_data_recebimento ?? m.data_recebimento_iso;
    }
    if (m.transp_cnpj) updateRow.transportadora_cnpj = m.transp_cnpj;
    if (m.transp_nome) updateRow.transportadora_nome = m.transp_nome;
    if (m.fornecedor_nome) updateRow.fornecedor_nome = m.fornecedor_nome;
    if (m.fornecedor_cnpj) updateRow.fornecedor_cnpj = m.fornecedor_cnpj;

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

async function syncEmpresa(
  supabase: SupabaseClient,
  empresa: Empresa,
  dias: number,
  fornecedorCodigo: number | undefined,
  t0: number,
  dataInicialOverride?: string,
  dataFinalOverride?: string,
): Promise<EmpresaSummary> {
  const summary: EmpresaSummary = {
    empresa,
    nfes_processadas: 0,
    consultas_detalhadas: 0,
    pedidos_vinculados: 0,
    nfes_com_multiplos_pedidos: 0,
    nfes_orfas: 0,
    vinculos_criados_total: 0,
    erros: 0,
  };

  const { app_key, app_secret } = getCredentials(empresa);

  let dataDe: string;
  let dataAte: string;
  if (dataInicialOverride && dataFinalOverride) {
    dataDe = dataInicialOverride;
    dataAte = dataFinalOverride;
  } else {
    const hoje = new Date();
    const inicio = new Date();
    inicio.setDate(hoje.getDate() - dias);
    dataDe = formatDateBR(inicio);
    dataAte = formatDateBR(hoje);
  }
  console.log(`[sync-nfes] ${empresa} janela ${dataDe} → ${dataAte}`);

  // Cache para evitar reprocessar mesma NFe (nIdReceb) no mesmo run
  const processadasNoRun = new Set<number>();

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
      resp = (await callOmie(app_key, app_secret, "ListarRecebimentos", param)) as OmieListRecebimentosResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-nfes] ${empresa} pag=${pagina} ListarRecebimentos erro: ${msg}`);
      summary.erros++;
      break;
    }

    if (resp?.faultstring) {
      const fs = String(resp.faultstring);
      if (/not\s*found|sem\s*registros|n[ãa]o\s*encontrado|nenhum\s*registro/i.test(fs)) {
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

      try {
        const m = mapNFe(nfe);
        if (!m.chave || !m.data_emissao_iso) {
          throw new Error(`NFe nIdReceb=${nIdReceb} sem chave ou dEmissaoNFe`);
        }

        // ConsultarRecebimento → busca itens e nNumPedCompra
        await sleep(RATE_LIMIT_DELAY_MS);
        let detalhe: OmieConsultarRecebimentoResponse;
        try {
          detalhe = (await callOmie(app_key, app_secret, "ConsultarRecebimento", { nIdReceb })) as OmieConsultarRecebimentoResponse;
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

        const numerosPedido = extractPedidosFromDetalhe(detalhe);

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
      const detalhe = (await callOmie(app_key, app_secret, "ConsultarRecebimento", { cChaveNFe: chave })) as OmieConsultarRecebimentoResponse;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
      return new Response(
        JSON.stringify({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    let body: RequestBody = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { body = {}; }
    }

    const empresaParam = (body.empresa ?? "ALL").toUpperCase() as "OBEN" | "COLACOR" | "ALL";
    const dias = typeof body.dias === "number" && body.dias > 0 ? body.dias : 30;
    const fornecedorCodigo = body.fornecedor_codigo_omie;
    const dataInicial = typeof body.data_inicial === "string" ? body.data_inicial : undefined;
    const dataFinal = typeof body.data_final === "string" ? body.data_final : undefined;
    const apenasBackfill = body.apenas_backfill === true;
    const pularBackfill = body.pular_backfill === true;

    const empresas: Empresa[] =
      empresaParam === "ALL" ? ["OBEN", "COLACOR"] : [empresaParam as Empresa];

    console.log(`[sync-nfes] início empresas=${empresas.join(",")} dias=${dias} janela=${dataInicial ?? "-"}→${dataFinal ?? "-"} fornecedor=${fornecedorCodigo ?? "todos"} apenas_backfill=${apenasBackfill} pular_backfill=${pularBackfill}`);

    const summary: EmpresaSummary[] = [];
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
          s = await syncEmpresa(supabase, empresa, dias, fornecedorCodigo, t0, dataInicial, dataFinal);
          console.log(
            `[sync-nfes] ${empresa} TOTAL: nfes=${s.nfes_processadas} ` +
            `consultas=${s.consultas_detalhadas} vinculadas=${s.pedidos_vinculados} ` +
            `multi=${s.nfes_com_multiplos_pedidos} orfas=${s.nfes_orfas} ` +
            `vinculos=${s.vinculos_criados_total} erros=${s.erros} dur=${Date.now() - t0}ms`,
          );
        }

        // Se o loop principal já estourou o guard de tempo, PULA o backfill: ele só
        // consumiria a margem que resta p/ o completeSync rodar (senão a linha fica
        // 'running' órfã). O backfill retroativo pega no próximo ciclo.
        if (s.interrompido_por_timeout && !pularBackfill) {
          console.warn(`[sync-nfes] ${empresa} main loop interrompido por tempo — pulando backfill p/ garantir completeSync`);
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
        await completeSync(supabase, empLogId, s as unknown as Record<string, unknown>, falhaSistemica, Date.now() - t0);
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

    return new Response(
      JSON.stringify({ ok: true, duracao_ms: Date.now() - t0, summary }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync-nfes] erro fatal:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg, duracao_ms: Date.now() - t0 }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
