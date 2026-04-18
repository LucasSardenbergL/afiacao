// Edge Function: omie-sync-ctes-recebidos
// Sincroniza CTes (modelo 57) recebidos do Omie e tenta vincular a NFes
// existentes em purchase_orders_tracking via match HEURÍSTICO (data + valor de frete).
//
// Pública (verify_jwt = false). Acionada via POST manual ou cron.
//
// Métodos Omie usados (endpoint /api/v1/produtos/recebimentonfe/):
//   - ListarRecebimentos (filtro cModeloNFe = "57")
//   - ConsultarRecebimento(nIdReceb)
//
// Match heurístico CTe → NFe:
//   Para cada CTe (data emissão dE_cte, valor frete v_frete):
//     candidatas = NFes em POT (mesma empresa+fornecedor) onde:
//        nfe_chave_acesso != null
//        t3_data_cte IS NULL (ainda sem CTe)
//        t2_data_faturamento entre (dE_cte - 3d) e dE_cte
//     score por candidata:
//        valor_esperado = valor_nfe * 0.025
//        desvio = |v_frete - valor_esperado| / valor_esperado
//        desvio <= 0.10 → 0.95   (alto)
//        desvio <= 0.20 → 0.75   (médio)
//        desvio  > 0.20 → 0.40   (baixo)
//     escolhe a NFe de MAIOR score (empate → mais próxima de dE_cte).
//     se melhor score < 0.40 → CTe órfão (não cria linha extra; só conta).
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
const FRETE_PCT_ESPERADO = 0.025; // 2.5% do valor da NFe

type Empresa = "OBEN" | "COLACOR";

interface RequestBody {
  empresa?: "OBEN" | "COLACOR" | "ALL";
  dias?: number;
  fornecedor_codigo_omie?: number;
}

interface EmpresaSummary {
  empresa: Empresa;
  ctes_processados: number;
  ctes_matched: number;
  ctes_sem_match: number;
  matches_alto_score: number;   // >= 0.90
  matches_medio_score: number;  // 0.70-0.90
  matches_baixo_score: number;  // 0.40-0.70
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
  fornecedor_codigo: number | null;
  data_emissao_iso: string | null;
  data_emissao_date: Date | null;
  valor_frete: number;
  transp_cnpj: string | null;
  transp_nome: string | null;
}

function mapCte(item: any, detalhe: any): MappedCte {
  const cab = detalhe?.cabec ?? item?.cabec ?? {};
  const transp = detalhe?.transporte ?? cab?.transporte ?? item?.transporte ?? {};

  const dataIso = parseBRDateToISO(cab?.dEmissaoNFe, "00:00:00");

  return {
    nIdReceb: Number(item?.infoCadastro?.nIdReceb ?? cab?.nIdReceb ?? 0),
    chave: (cab?.cChaveNFe ?? cab?.cChaveNfe)
      ? String(cab.cChaveNFe ?? cab.cChaveNfe).replace(/\D/g, "").slice(0, 44)
      : null,
    numero: cab?.cNumeroNFe ? String(cab.cNumeroNFe) : null,
    fornecedor_codigo: cab?.nIdFornecedor ? Number(cab.nIdFornecedor) : null,
    data_emissao_iso: dataIso,
    data_emissao_date: dataIso ? new Date(dataIso) : null,
    valor_frete: Number(cab?.nValorNFe ?? 0),
    transp_cnpj: transp?.cCnpjCpfTransp ? String(transp.cCnpjCpfTransp).replace(/\D/g, "") : null,
    transp_nome: transp?.cRazaoTransp ?? transp?.cNomeTransp ?? null,
  };
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
  desvio: number;
}

function calcularMatch(cte: MappedCte, candidatas: NFeCandidata[]): MatchResult | null {
  if (cte.valor_frete <= 0 || candidatas.length === 0) return null;

  const matches: MatchResult[] = [];
  for (const c of candidatas) {
    if (!c.valor_nfe || c.valor_nfe <= 0) continue;
    const valorEsperado = c.valor_nfe * FRETE_PCT_ESPERADO;
    const desvio = Math.abs(cte.valor_frete - valorEsperado) / valorEsperado;
    let score = 0;
    if (desvio <= 0.10) score = 0.95;
    else if (desvio <= 0.20) score = 0.75;
    else score = 0.40;
    matches.push({ candidata: c, score, desvio });
  }

  if (matches.length === 0) return null;

  // ordena: maior score; empate → fatura mais próxima da emissão do CTe
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (!cte.data_emissao_date) return 0;
    const da = Math.abs(new Date(a.candidata.t2_data_faturamento).getTime() - cte.data_emissao_date.getTime());
    const db = Math.abs(new Date(b.candidata.t2_data_faturamento).getTime() - cte.data_emissao_date.getTime());
    return da - db;
  });

  const best = matches[0];
  if (best.score < 0.40) return null;
  return best;
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

async function processarEmpresa(
  supabase: ReturnType<typeof createClient>,
  empresa: Empresa,
  dias: number,
  fornecedorCodigo: number | null,
): Promise<EmpresaSummary> {
  const summary: EmpresaSummary = {
    empresa,
    ctes_processados: 0,
    ctes_matched: 0,
    ctes_sem_match: 0,
    matches_alto_score: 0,
    matches_medio_score: 0,
    matches_baixo_score: 0,
    erros: 0,
  };

  const { app_key, app_secret } = getCredentials(empresa);
  const fim = new Date();
  const inicio = new Date(fim.getTime() - dias * 24 * 60 * 60 * 1000);
  const dEmissaoDe = formatDateBR(inicio);
  const dEmissaoAte = formatDateBR(fim);

  console.log(`[sync-ctes] ${empresa} período ${dEmissaoDe} → ${dEmissaoAte} (modelo 57)`);

  // 1) Lista TODOS recebimentos do período (NFe + CTe). API NÃO aceita filtro cModeloNFe.
  //    Filtramos em memória por cabec.cModeloNFe === "57".
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
    // NÃO passamos nIdFornecedor: o fornecedor do CTe é a TRANSPORTADORA, não a Sayerlack.
    // O filtro por fornecedor (Sayerlack) é aplicado depois, na busca de candidatas NFe.

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

  // 2) Para cada CTe, ConsultarRecebimento + match heurístico
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
      if (!cte.data_emissao_date || cte.valor_frete <= 0) {
        summary.ctes_sem_match++;
        console.log(`[sync-ctes] CTe ${nIdReceb} sem dados mínimos (data ou valor frete)`);
        continue;
      }
      if (!fornecedorCodigo) {
        summary.ctes_sem_match++;
        console.log(`[sync-ctes] CTe ${nIdReceb} sem fornecedor_codigo_omie no request`);
        continue;
      }

      const candidatas = await buscarCandidatas(supabase, empresa, fornecedorCodigo, cte);
      console.log(`[sync-ctes] CTe ${cte.numero} (R$${cte.valor_frete.toFixed(2)}) → ${candidatas.length} candidatas`);

      const match = calcularMatch(cte, candidatas);
      if (!match) {
        summary.ctes_sem_match++;
        continue;
      }

      // UPDATE na linha da NFe
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
        })
        .eq("id", match.candidata.id);

      if (upErr) {
        console.error(`[sync-ctes] update falhou pedido ${match.candidata.numero_pedido}:`, upErr);
        summary.erros++;
        continue;
      }

      summary.ctes_matched++;
      if (match.score >= 0.90) summary.matches_alto_score++;
      else if (match.score >= 0.70) summary.matches_medio_score++;
      else summary.matches_baixo_score++;

      console.log(
        `[sync-ctes] MATCH CTe ${cte.numero} ↔ pedido ${match.candidata.numero_pedido} ` +
        `score=${match.score} desvio=${(match.desvio * 100).toFixed(1)}%`,
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
    const fornecedor = body.fornecedor_codigo_omie ?? null;

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
          ctes_matched: 0,
          ctes_sem_match: 0,
          matches_alto_score: 0,
          matches_medio_score: 0,
          matches_baixo_score: 0,
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
