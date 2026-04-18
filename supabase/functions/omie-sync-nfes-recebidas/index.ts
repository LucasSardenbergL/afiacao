// Edge Function: omie-sync-nfes-recebidas
// Sincroniza NFes de entrada (recebidas) do Omie (Oben + Colacor) para a tabela purchase_orders_tracking.
// Pública (verify_jwt = false) — acionada via POST manual ou cron.
//
// Método Omie usado: ListarRecebimentos (endpoint /api/v1/produtos/recebimentonfe/)
// Doc: https://app.omie.com.br/api/v1/produtos/recebimentonfe/#ListarRecebimentos
//
// Estratégia de UPSERT:
//   - Se já existe linha em purchase_orders_tracking com mesma nfe_chave_acesso → UPDATE
//     preenche T2 (= dEmissaoNFe), nfe_numero, nfe_serie, status (FATURADO se ainda não recebido/cancelado)
//   - Caso contrário → INSERT criando "NFe órfã" (sem pedido formal):
//     omie_codigo_pedido = -nIdReceb (negativo p/ não colidir com pedidos reais),
//     t1_data_pedido = dEmissaoNFe (fallback), t2_data_faturamento = dEmissaoNFe,
//     grupo_leadtime = "OUTRO", status = "FATURADO"
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
  total_paginas: number;
  nfes_sincronizadas: number;
  nfes_com_pedido: number;
  nfes_sem_pedido: number;
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
  // Filtros conforme rcbtoListarRequest da doc oficial
  const param: Record<string, unknown> = {
    nPagina: pagina,
    nRegistrosPorPagina: PAGE_SIZE,
    cOrdenarPor: "CODIGO",
    dtEmissaoDe: dataDe,
    dtEmissaoAte: dataAte,
    cExibirDetalhes: "S",
    // cEtapa vazio = TODAS as etapas (cadastro, conferência, concluído, faturado, recebido, cancelado)
    cEtapa: "",
  };
  if (fornecedorCodigo) {
    param.nIdFornecedor = fornecedorCodigo;
  }

  const body = {
    call: "ListarRecebimentos",
    app_key,
    app_secret,
    param: [param],
  };

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
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (res.status === 429 || (json?.faultstring && /rate limit/i.test(json.faultstring))) {
      console.warn(`[sync-nfes] rate limit atingido (tentativa ${attempt}/${MAX_RETRIES}), aguardando ${RETRY_DELAY_MS}ms`);
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

/**
 * Mapeia uma NFe retornada por ListarRecebimentos.
 * Estrutura (recebimentos[]):
 *   { cabec: { nIdReceb, cChaveNfe, cNumeroNFe, cSerieNFe, dEmissaoNFe,
 *              nIdFornecedor, cRazaoSocial, cCNPJ_CPF, cEtapa, nValorNFe, ... },
 *     infoCadastro: { cFaturado, dFat, hFat, cRecebido, dRec, hRec, cCancelada, dCanc, ... },
 *     totais: { ... }, transporte: { cCnpjCpfTransp, cRazaoTransp, ... }, ... }
 */
function mapNFe(nfe: any): {
  chave: string | null;
  fornecedor_codigo: number | null;
  fornecedor_nome: string | null;
  fornecedor_cnpj: string | null;
  numero: string | null;
  serie: string | null;
  data_emissao_iso: string | null;
  cancelada: boolean;
  status: "FATURADO" | "RECEBIDO" | "CANCELADO";
  transp_cnpj: string | null;
  transp_nome: string | null;
} {
  const cab = nfe?.cabec ?? {};
  const info = nfe?.infoCadastro ?? {};
  const transp = nfe?.transporte ?? {};

  const cancelada = String(info?.cCancelada ?? "N").toUpperCase() === "S";
  const recebida = String(info?.cRecebido ?? "N").toUpperCase() === "S";

  let status: "FATURADO" | "RECEBIDO" | "CANCELADO" = "FATURADO";
  if (cancelada) status = "CANCELADO";
  else if (recebida) status = "RECEBIDO";

  return {
    chave: cab?.cChaveNfe ? String(cab.cChaveNfe).replace(/\D/g, "").slice(0, 44) : null,
    fornecedor_codigo: cab?.nIdFornecedor ? Number(cab.nIdFornecedor) : null,
    fornecedor_nome: cab?.cRazaoSocial ?? cab?.cNome ?? null,
    fornecedor_cnpj: cab?.cCNPJ_CPF ? String(cab.cCNPJ_CPF).replace(/\D/g, "") : null,
    numero: cab?.cNumeroNFe ?? null,
    serie: cab?.cSerieNFe ?? null,
    data_emissao_iso: parseBRDateToISO(cab?.dEmissaoNFe, "00:00:00"),
    cancelada,
    status,
    transp_cnpj: transp?.cCnpjCpfTransp ? String(transp.cCnpjCpfTransp).replace(/\D/g, "") : null,
    transp_nome: transp?.cRazaoTransp ?? transp?.cNomeTransp ?? null,
  };
}

async function upsertNFe(
  supabase: ReturnType<typeof createClient>,
  empresa: Empresa,
  nfe: any,
  m: ReturnType<typeof mapNFe>,
  nIdReceb: number,
): Promise<"com_pedido" | "sem_pedido"> {
  if (!m.chave) {
    throw new Error("NFe sem cChaveNfe");
  }
  if (!m.data_emissao_iso) {
    throw new Error(`NFe ${m.chave} sem dEmissaoNFe`);
  }

  // 1) Tenta achar linha existente pela chave NFe (vínculo via webhook ou sync de pedidos)
  const { data: existingByChave, error: selErr } = await supabase
    .from("purchase_orders_tracking")
    .select("id, status, t2_data_faturamento, t4_data_recebimento")
    .eq("empresa", empresa)
    .eq("nfe_chave_acesso", m.chave)
    .maybeSingle();

  if (selErr) throw selErr;

  if (existingByChave?.id) {
    // UPDATE: preserva T4/RECEBIDO/CANCELADO; só sobrescreve status para FATURADO se ainda não evoluiu
    const currentStatus = String(existingByChave.status ?? "");
    const finalStatus =
      currentStatus === "RECEBIDO" || currentStatus === "CANCELADO"
        ? currentStatus
        : m.status;

    const updateRow: Record<string, unknown> = {
      t2_data_faturamento: existingByChave.t2_data_faturamento ?? m.data_emissao_iso,
      nfe_numero: m.numero,
      nfe_serie: m.serie,
      status: finalStatus,
      updated_at: new Date().toISOString(),
    };
    if (m.transp_cnpj) updateRow.transportadora_cnpj = m.transp_cnpj;
    if (m.transp_nome) updateRow.transportadora_nome = m.transp_nome;
    if (m.fornecedor_nome) updateRow.fornecedor_nome = m.fornecedor_nome;
    if (m.fornecedor_cnpj) updateRow.fornecedor_cnpj = m.fornecedor_cnpj;

    const { error: updErr } = await supabase
      .from("purchase_orders_tracking")
      .update(updateRow)
      .eq("id", existingByChave.id);
    if (updErr) throw updErr;
    return "com_pedido";
  }

  // 2) NFe órfã (fornecedor sem pedido formal) — INSERT
  // Usa omie_codigo_pedido = -nIdReceb (negativo) para não colidir com pedidos reais.
  if (!m.fornecedor_codigo) {
    throw new Error(`NFe ${m.chave} sem nIdFornecedor — não pode inserir órfã`);
  }

  const insertRow: Record<string, unknown> = {
    empresa,
    omie_codigo_pedido: -Math.abs(nIdReceb), // negativo = sintético, derivado de nIdReceb
    fornecedor_codigo_omie: m.fornecedor_codigo,
    fornecedor_nome: m.fornecedor_nome,
    fornecedor_cnpj: m.fornecedor_cnpj,
    grupo_leadtime: "OUTRO",
    status: m.status,
    t1_data_pedido: m.data_emissao_iso, // fallback: usa T2 como T1
    t2_data_faturamento: m.data_emissao_iso,
    nfe_chave_acesso: m.chave,
    nfe_numero: m.numero,
    nfe_serie: m.serie,
    transportadora_cnpj: m.transp_cnpj,
    transportadora_nome: m.transp_nome,
    raw_data: nfe,
  };

  // Pode haver outra NFe órfã com mesmo (-nIdReceb) já inserida (rerun) → upsert por chave manual
  const { data: existingByOrfaKey } = await supabase
    .from("purchase_orders_tracking")
    .select("id")
    .eq("empresa", empresa)
    .eq("omie_codigo_pedido", -Math.abs(nIdReceb))
    .maybeSingle();

  if (existingByOrfaKey?.id) {
    const { error: updErr } = await supabase
      .from("purchase_orders_tracking")
      .update({ ...insertRow, updated_at: new Date().toISOString() })
      .eq("id", existingByOrfaKey.id);
    if (updErr) throw updErr;
  } else {
    const { error: insErr } = await supabase
      .from("purchase_orders_tracking")
      .insert(insertRow);
    if (insErr) throw insErr;
  }
  return "sem_pedido";
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
    nfes_sincronizadas: 0,
    nfes_com_pedido: 0,
    nfes_sem_pedido: 0,
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
      console.error(`[sync-nfes] empresa=${empresa} pagina=${pagina} erro fetch: ${msg}`);
      summary.erros++;
      break;
    }

    if (resp?.faultstring) {
      const fs = String(resp.faultstring);
      if (/not\s*found|sem\s*registros|n[ãa]o\s*encontrado|nenhum\s*registro/i.test(fs)) {
        console.log(`[sync-nfes] empresa=${empresa} pagina=${pagina} sem resultados — encerrando`);
        break;
      }
      console.error(`[sync-nfes] empresa=${empresa} pagina=${pagina} faultstring: ${fs}`);
      summary.erros++;
      break;
    }

    totalPaginas = Number(resp?.nTotalPaginas ?? 1);
    const nfes: any[] = Array.isArray(resp?.recebimentos) ? resp.recebimentos : [];

    // DEBUG (página 1)
    if (pagina === 1) {
      console.log(
        `[sync-nfes] DEBUG empresa=${empresa} top-level keys=${JSON.stringify(Object.keys(resp || {}))} ` +
        `nTotalRegistros=${resp?.nTotalRegistros} nTotalPaginas=${totalPaginas}`,
      );
      if (nfes.length > 0) {
        console.log(`[sync-nfes] SHAPE primeira NFe: ${JSON.stringify(nfes[0], null, 2).slice(0, 4000)}`);
      }
    }

    console.log(
      `[sync-nfes] empresa=${empresa} pagina=${pagina} recebidas=${nfes.length} (total_paginas=${totalPaginas})`,
    );

    for (const nfe of nfes) {
      const nIdReceb = Number(nfe?.cabec?.nIdReceb ?? 0);
      try {
        const m = mapNFe(nfe);
        const tipo = await upsertNFe(supabase, empresa, nfe, m, nIdReceb);
        summary.nfes_sincronizadas++;
        if (tipo === "com_pedido") summary.nfes_com_pedido++;
        else summary.nfes_sem_pedido++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-nfes] empresa=${empresa} nIdReceb=${nIdReceb} chave=${nfe?.cabec?.cChaveNfe} erro: ${msg}`);
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
      `[sync-nfes] início empresas=${empresas.join(",")} dias=${dias} fornecedor=${fornecedorCodigo ?? "todos"}`,
    );

    const summary: EmpresaSummary[] = [];
    for (const empresa of empresas) {
      try {
        const s = await syncEmpresa(supabase, empresa, dias, fornecedorCodigo);
        summary.push(s);
        console.log(
          `[sync-nfes] empresa=${empresa} TOTAL: paginas=${s.total_paginas} ` +
          `nfes=${s.nfes_sincronizadas} (com_pedido=${s.nfes_com_pedido} sem_pedido=${s.nfes_sem_pedido}) ` +
          `erros=${s.erros} duracao=${Date.now() - t0}ms`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync-nfes] empresa=${empresa} erro fatal: ${msg}`);
        summary.push({
          empresa,
          total_paginas: 0,
          nfes_sincronizadas: 0,
          nfes_com_pedido: 0,
          nfes_sem_pedido: 0,
          erros: 1,
        });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        duracao_ms: Date.now() - t0,
        summary,
      }),
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
