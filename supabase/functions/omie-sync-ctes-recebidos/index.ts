// Edge Function: omie-sync-ctes-recebidos
// Sincroniza CTes (modelo 57) recebidos do Omie e tenta vincular a NFes Sayerlack
// existentes em purchase_orders_tracking via match POR TRANSPORTADORA.
//
// Pública (verify_jwt = false). Acionada via POST manual ou cron.
//
// Regras de match (Sayerlack apenas — fornecedor_codigo_omie = 8689681266):
//   1. Identificar transportadora pela tag transporte.cRazaoTransp do detalhe do CTe.
//   2. Filtrar candidatas:
//        - empresa = OBEN, fornecedor_codigo_omie = SAYERLACK
//        - t2_data_faturamento entre (cte_data - 3d) e cte_data
//        - t3_data_cte IS NULL  (NFe ainda sem CTe)
//   3. Aplicar regra por transportadora:
//        SP_MINAS  → método "SP_MINAS_25PCT": valor_esperado = nfe_valor * 0.025
//                    desvio <= 15% → score 0.95
//                    desvio <= 30% → score 0.75
//                    desvio  > 30% → órfão
//                    múltiplas candidatas válidas → menor desvio
//        CONECT    → método "CONECT_DATA_FALLBACK": apenas janela de data
//                    1 candidata    → score 0.60
//                    2+ candidatas  → mais próxima em data, score 0.50
//                    0 candidatas   → órfão
//        OUTRAS    → não tentar match com NFes Sayerlack (registra órfão).
//   4. Nunca matchar NFe que já tem t3_data_cte preenchido (filtro 2).
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
const CTE_MODELO = "57";
const SAYERLACK_FORNECEDOR_DEFAULT = 8689681266;

// SP Minas – % esperado
const SPMINAS_FRETE_PCT = 0.025;
const SPMINAS_DESVIO_ALTO = 0.15;
const SPMINAS_DESVIO_MEDIO = 0.30;

type Empresa = "OBEN" | "COLACOR";
type MatchMetodo = "SP_MINAS_25PCT" | "CONECT_DATA_FALLBACK";

interface RequestBody {
  empresa?: "OBEN" | "COLACOR" | "ALL";
  dias?: number;
  fornecedor_codigo_omie?: number;
}

interface EmpresaSummary {
  empresa: Empresa;
  ctes_processados: number;
  ctes_sp_minas: number;
  ctes_conect: number;
  ctes_outras_transp_ignoradas: number;
  matches_alto_score_sp_minas: number;
  matches_medio_score_sp_minas: number;
  matches_conect: number;
  ctes_orfaos: number;
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
      console.warn(`[sync-ctes] ${call} rate limit (try ${attempt}/${MAX_RETRIES})`);
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

interface MappedCte {
  nIdReceb: number;
  chave: string | null;
  numero: string | null;
  data_emissao_iso: string | null;
  data_emissao_date: Date | null;
  valor_frete: number;
  transp_cnpj: string | null;
  transp_nome: string | null;
}

function mapCte(item: any, detalhe: any): MappedCte {
  const cab = detalhe?.cabec ?? item?.cabec ?? {};
  // Tag correta da transportadora: transporte.cRazaoTransp (não cabec).
  const transp = detalhe?.transporte ?? item?.transporte ?? {};

  const dataIso = parseBRDateToISO(cab?.dEmissaoNFe, "00:00:00");

  return {
    nIdReceb: Number(item?.infoCadastro?.nIdReceb ?? cab?.nIdReceb ?? 0),
    chave: (cab?.cChaveNFe ?? cab?.cChaveNfe)
      ? String(cab.cChaveNFe ?? cab.cChaveNfe).replace(/\D/g, "").slice(0, 44)
      : null,
    numero: cab?.cNumeroNFe ? String(cab.cNumeroNFe) : null,
    data_emissao_iso: dataIso,
    data_emissao_date: dataIso ? new Date(dataIso) : null,
    valor_frete: Number(cab?.nValorNFe ?? 0),
    transp_cnpj: transp?.cCnpjCpfTransp ? String(transp.cCnpjCpfTransp).replace(/\D/g, "") : null,
    transp_nome: transp?.cRazaoTransp ?? transp?.cNomeTransp ?? null,
  };
}

type TranspKind = "SP_MINAS" | "CONECT" | "OUTRA";

function classificarTransp(nome: string | null): TranspKind {
  if (!nome) return "OUTRA";
  const n = nome.toUpperCase();
  if (n.includes("SP MINAS") || n.includes("SPMINAS")) return "SP_MINAS";
  if (n.includes("CONECT")) return "CONECT";
  return "OUTRA";
}

interface NFeCandidata {
  id: string;
  numero_pedido: string | null;
  t2_data_faturamento: string;
  valor_nfe: number;
}

interface MatchResult {
  candidata: NFeCandidata;
  score: number;
  desvio: number | null;
  metodo: MatchMetodo;
}

async function buscarCandidatas(
  supabase: ReturnType<typeof createClient>,
  empresa: Empresa,
  fornecedorCodigo: number,
  cte: MappedCte,
): Promise<NFeCandidata[]> {
  if (!cte.data_emissao_date) return [];
  const dataFim = cte.data_emissao_date;
  const dataInicio = new Date(dataFim.getTime() - 3 * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("purchase_orders_tracking")
    .select("id, numero_pedido, t2_data_faturamento, raw_data")
    .eq("empresa", empresa)
    .eq("fornecedor_codigo_omie", fornecedorCodigo)
    .not("nfe_chave_acesso", "is", null)
    .is("t3_data_cte", null)
    .gte("t2_data_faturamento", dataInicio.toISOString())
    .lte("t2_data_faturamento", dataFim.toISOString())
    .order("t2_data_faturamento", { ascending: false });

  if (error) {
    console.error("[sync-ctes] buscarCandidatas erro:", error);
    return [];
  }

  return (data ?? []).map((row: any) => {
    const valorNfe = Number(row?.raw_data?.cabec?.nValorNFe ?? 0);
    return {
      id: row.id,
      numero_pedido: row.numero_pedido,
      t2_data_faturamento: row.t2_data_faturamento,
      valor_nfe: valorNfe,
    } as NFeCandidata;
  });
}

function matchSpMinas(cte: MappedCte, candidatas: NFeCandidata[]): MatchResult | null {
  if (cte.valor_frete <= 0 || candidatas.length === 0) return null;

  type Calc = { c: NFeCandidata; desvio: number };
  const calc: Calc[] = [];
  for (const c of candidatas) {
    if (!c.valor_nfe || c.valor_nfe <= 0) continue;
    const valorEsperado = c.valor_nfe * SPMINAS_FRETE_PCT;
    const desvio = Math.abs(cte.valor_frete - valorEsperado) / valorEsperado;
    if (desvio <= SPMINAS_DESVIO_MEDIO) {
      calc.push({ c, desvio });
    }
  }
  if (calc.length === 0) return null;

  // menor desvio primeiro
  calc.sort((a, b) => a.desvio - b.desvio);
  const best = calc[0];
  const score = best.desvio <= SPMINAS_DESVIO_ALTO ? 0.95 : 0.75;
  return { candidata: best.c, score, desvio: best.desvio, metodo: "SP_MINAS_25PCT" };
}

function matchConect(cte: MappedCte, candidatas: NFeCandidata[]): MatchResult | null {
  if (candidatas.length === 0 || !cte.data_emissao_date) return null;

  if (candidatas.length === 1) {
    return { candidata: candidatas[0], score: 0.60, desvio: null, metodo: "CONECT_DATA_FALLBACK" };
  }
  // 2+: mais próxima em data do CTe
  const ordered = [...candidatas].sort((a, b) => {
    const da = Math.abs(new Date(a.t2_data_faturamento).getTime() - cte.data_emissao_date!.getTime());
    const db = Math.abs(new Date(b.t2_data_faturamento).getTime() - cte.data_emissao_date!.getTime());
    return da - db;
  });
  return { candidata: ordered[0], score: 0.50, desvio: null, metodo: "CONECT_DATA_FALLBACK" };
}

async function processarEmpresa(
  supabase: ReturnType<typeof createClient>,
  empresa: Empresa,
  dias: number,
  fornecedorCodigo: number,
): Promise<EmpresaSummary> {
  const summary: EmpresaSummary = {
    empresa,
    ctes_processados: 0,
    ctes_sp_minas: 0,
    ctes_conect: 0,
    ctes_outras_transp_ignoradas: 0,
    matches_alto_score_sp_minas: 0,
    matches_medio_score_sp_minas: 0,
    matches_conect: 0,
    ctes_orfaos: 0,
    erros: 0,
  };

  const { app_key, app_secret } = getCredentials(empresa);
  const fim = new Date();
  const inicio = new Date(fim.getTime() - dias * 24 * 60 * 60 * 1000);
  const dEmissaoDe = formatDateBR(inicio);
  const dEmissaoAte = formatDateBR(fim);

  console.log(`[sync-ctes] ${empresa} período ${dEmissaoDe} → ${dEmissaoAte} (modelo 57)`);

  // 1) Lista TODOS recebimentos do período. Filtra modelo 57 em memória.
  const ctesBase: any[] = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const param: Record<string, unknown> = {
      nPagina: pagina,
      nRegistrosPorPagina: PAGE_SIZE,
      cOrdenarPor: "CODIGO",
      cExibirDetalhes: "S",
      cEtapa: "",
      dtEmissaoDe: dEmissaoDe,
      dtEmissaoAte: dEmissaoAte,
    };

    const resp = await callOmie(app_key, app_secret, "ListarRecebimentos", param);
    const lista: any[] =
      resp?.recebimentos ?? resp?.recebimentosCadastro ?? resp?.nfCadastro ?? resp?.cadastros ?? resp?.nfes ?? [];
    const apenasCtes = lista.filter((it) => String(it?.cabec?.cModeloNFe ?? "") === CTE_MODELO);
    ctesBase.push(...apenasCtes);
    totalPaginas = Number(resp?.nTotPaginas ?? resp?.total_de_paginas ?? 1);
    console.log(`[sync-ctes] ${empresa} pág ${pagina}/${totalPaginas} → ${lista.length} itens (${apenasCtes.length} CTes)`);
    pagina++;
    await sleep(RATE_LIMIT_DELAY_MS);
  } while (pagina <= totalPaginas);

  console.log(`[sync-ctes] ${empresa} total CTes período: ${ctesBase.length}`);

  // 2) Para cada CTe, ConsultarRecebimento + match por transportadora
  for (const item of ctesBase) {
    try {
      summary.ctes_processados++;
      const nIdReceb = Number(item?.infoCadastro?.nIdReceb ?? item?.cabec?.nIdReceb);
      if (!nIdReceb) {
        summary.erros++;
        continue;
      }

      const det = await callOmie(app_key, app_secret, "ConsultarRecebimento", { nIdReceb });
      await sleep(RATE_LIMIT_DELAY_MS);

      const cte = mapCte(item, det);
      const transpKind = classificarTransp(cte.transp_nome);

      if (transpKind === "OUTRA") {
        summary.ctes_outras_transp_ignoradas++;
        console.log(`[sync-ctes] CTe ${cte.numero} transp="${cte.transp_nome}" — ignorada (não SP Minas / não Conect)`);
        continue;
      }

      if (!cte.data_emissao_date) {
        summary.erros++;
        console.log(`[sync-ctes] CTe ${nIdReceb} sem data de emissão`);
        continue;
      }

      if (transpKind === "SP_MINAS") summary.ctes_sp_minas++;
      else if (transpKind === "CONECT") summary.ctes_conect++;

      const candidatas = await buscarCandidatas(supabase, empresa, fornecedorCodigo, cte);
      console.log(
        `[sync-ctes] CTe ${cte.numero} (${transpKind}, R$${cte.valor_frete.toFixed(2)}) ` +
        `→ ${candidatas.length} candidatas Sayerlack na janela`,
      );

      let match: MatchResult | null = null;
      if (transpKind === "SP_MINAS") {
        match = matchSpMinas(cte, candidatas);
      } else if (transpKind === "CONECT") {
        match = matchConect(cte, candidatas);
      }

      if (!match) {
        summary.ctes_orfaos++;
        continue;
      }

      const { error: upErr } = await supabase
        .from("purchase_orders_tracking")
        .update({
          t3_data_cte: cte.data_emissao_iso,
          cte_chave_acesso: cte.chave,
          cte_numero: cte.numero,
          cte_valor_frete: cte.valor_frete,
          cte_transportadora_nome_real: cte.transp_nome,
          cte_transportadora_cnpj: cte.transp_cnpj,
          match_cte_score: match.score,
          match_cte_metodo: match.metodo,
        })
        .eq("id", match.candidata.id);

      if (upErr) {
        console.error(`[sync-ctes] update falhou pedido ${match.candidata.numero_pedido}:`, upErr);
        summary.erros++;
        continue;
      }

      if (match.metodo === "SP_MINAS_25PCT") {
        if (match.score >= 0.90) summary.matches_alto_score_sp_minas++;
        else summary.matches_medio_score_sp_minas++;
      } else {
        summary.matches_conect++;
      }

      const desvioStr = match.desvio !== null ? ` desvio=${(match.desvio * 100).toFixed(1)}%` : "";
      console.log(
        `[sync-ctes] MATCH ${match.metodo} CTe ${cte.numero} ↔ pedido ${match.candidata.numero_pedido} ` +
        `score=${match.score}${desvioStr}`,
      );
    } catch (e) {
      console.error("[sync-ctes] erro item:", e);
      summary.erros++;
    }
  }

  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const t0 = Date.now();
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: RequestBody = {};
    try { body = await req.json(); } catch { /* default */ }

    const empresaParam = (body.empresa ?? "OBEN") as "OBEN" | "COLACOR" | "ALL";
    const dias = Number(body.dias ?? 30);
    const fornecedor = Number(body.fornecedor_codigo_omie ?? SAYERLACK_FORNECEDOR_DEFAULT);

    const empresas: Empresa[] = empresaParam === "ALL" ? ["OBEN", "COLACOR"] : [empresaParam];

    const summaries: EmpresaSummary[] = [];
    for (const emp of empresas) {
      try {
        summaries.push(await processarEmpresa(supabase, emp, dias, fornecedor));
      } catch (e) {
        console.error(`[sync-ctes] empresa ${emp} falhou:`, e);
        summaries.push({
          empresa: emp,
          ctes_processados: 0,
          ctes_sp_minas: 0,
          ctes_conect: 0,
          ctes_outras_transp_ignoradas: 0,
          matches_alto_score_sp_minas: 0,
          matches_medio_score_sp_minas: 0,
          matches_conect: 0,
          ctes_orfaos: 0,
          erros: 1,
        });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, duracao_ms: Date.now() - t0, summary: summaries }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[sync-ctes] erro fatal:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
