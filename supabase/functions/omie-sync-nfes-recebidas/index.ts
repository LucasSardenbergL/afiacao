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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OMIE_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
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
  nfes_processadas: number;
  consultas_detalhadas: number;       // quantas ConsultarRecebimento rodaram com sucesso
  pedidos_vinculados: number;         // NFes que casaram com 1+ pedido real
  nfes_com_multiplos_pedidos: number; // NFes que referenciaram 2+ pedidos distintos
  nfes_orfas: number;                 // NFes inseridas como órfãs
  vinculos_criados_total: number;     // soma de UPDATEs em linhas de pedido (NFe×pedido)
  erros: number;
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
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (res.status === 429 || (json?.faultstring && /rate limit/i.test(json.faultstring))) {
      console.warn(`[sync-nfes] ${call} rate limit (try ${attempt}/${MAX_RETRIES}) wait ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Omie ${call} HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return json;
  }
  throw new Error(`Omie ${call}: rate limit excedido após ${MAX_RETRIES} tentativas`);
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

function mapNFe(nfe: any): MappedNFe {
  const cab = nfe?.cabec ?? {};
  const info = nfe?.infoCadastro ?? {};
  const transp = cab?.transporte ?? nfe?.transporte ?? {};

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
function extractPedidosFromDetalhe(detalhe: any): string[] {
  const itens: any[] = Array.isArray(detalhe?.itensRecebimento) ? detalhe.itensRecebimento : [];
  const set = new Set<string>();
  for (const it of itens) {
    const adic = it?.itensInfoAdic ?? {};
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
  supabase: ReturnType<typeof createClient>,
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
  const { data: linhas, error: selErr } = await q;
  if (selErr) throw selErr;
  if (!linhas || linhas.length === 0) return 0;

  let atualizadas = 0;
  for (const linha of linhas) {
    const currentStatus = String((linha as any).status ?? "");
    let finalStatus: "FATURADO" | "RECEBIDO" | "CANCELADO" = m.status;
    if (currentStatus === "CANCELADO") finalStatus = "CANCELADO";
    else if (currentStatus === "RECEBIDO" && m.status === "FATURADO") finalStatus = "RECEBIDO";

    const updateRow: Record<string, unknown> = {
      t2_data_faturamento: (linha as any).t2_data_faturamento ?? m.data_emissao_iso,
      nfe_chave_acesso: m.chave,
      nfe_numero: m.numero,
      nfe_serie: m.serie,
      status: finalStatus,
      updated_at: new Date().toISOString(),
    };
    if (m.recebida && m.data_recebimento_iso) {
      updateRow.t4_data_recebimento = (linha as any).t4_data_recebimento ?? m.data_recebimento_iso;
    }
    if (m.transp_cnpj) updateRow.transportadora_cnpj = m.transp_cnpj;
    if (m.transp_nome) updateRow.transportadora_nome = m.transp_nome;
    if (m.fornecedor_nome) updateRow.fornecedor_nome = m.fornecedor_nome;
    if (m.fornecedor_cnpj) updateRow.fornecedor_cnpj = m.fornecedor_cnpj;

    const { error: updErr } = await supabase
      .from("purchase_orders_tracking")
      .update(updateRow)
      .eq("id", (linha as any).id);
    if (updErr) throw updErr;
    atualizadas++;
  }
  return atualizadas;
}

async function insertOrfa(
  supabase: ReturnType<typeof createClient>,
  empresa: Empresa,
  nfe: any,
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
  supabase: ReturnType<typeof createClient>,
  empresa: Empresa,
  dias: number,
  fornecedorCodigo: number | undefined,
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

  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - dias);
  const dataDe = formatDateBR(inicio);
  const dataAte = formatDateBR(hoje);

  // Cache para evitar reprocessar mesma NFe (nIdReceb) no mesmo run
  const processadasNoRun = new Set<number>();

  let pagina = 1;
  let totalPaginas = 1;

  while (pagina <= totalPaginas) {
    let resp: any;
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
      resp = await callOmie(app_key, app_secret, "ListarRecebimentos", param);
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
    const nfes: any[] = Array.isArray(resp?.recebimentos) ? resp.recebimentos : [];
    console.log(`[sync-nfes] ${empresa} pag=${pagina}/${totalPaginas} nfes=${nfes.length}`);

    for (const nfe of nfes) {
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
        let detalhe: any;
        try {
          detalhe = await callOmie(app_key, app_secret, "ConsultarRecebimento", { nIdReceb });
          summary.consultas_detalhadas++;
        } catch (errDet) {
          const msgDet = errDet instanceof Error ? errDet.message : String(errDet);
          console.warn(`[sync-nfes] ${empresa} nIdReceb=${nIdReceb} ConsultarRecebimento falhou: ${msgDet} — tratando como órfã`);
          detalhe = null;
        }

        const numerosPedido = detalhe ? extractPedidosFromDetalhe(detalhe) : [];

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

    pagina++;
    if (pagina <= totalPaginas) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  return summary;
}

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

    const empresas: Empresa[] =
      empresaParam === "ALL" ? ["OBEN", "COLACOR"] : [empresaParam as Empresa];

    console.log(`[sync-nfes] início empresas=${empresas.join(",")} dias=${dias} fornecedor=${fornecedorCodigo ?? "todos"}`);

    const summary: EmpresaSummary[] = [];
    for (const empresa of empresas) {
      try {
        const s = await syncEmpresa(supabase, empresa, dias, fornecedorCodigo);
        summary.push(s);
        console.log(
          `[sync-nfes] ${empresa} TOTAL: nfes=${s.nfes_processadas} ` +
          `vinculadas=${s.pedidos_vinculados} orfas=${s.nfes_orfas} ` +
          `vinculos=${s.vinculos_criados_total} erros=${s.erros} dur=${Date.now() - t0}ms`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-nfes] ${empresa} erro fatal: ${msg}`);
        summary.push({
          empresa,
          nfes_processadas: 0,
          pedidos_vinculados: 0,
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
