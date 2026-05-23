// supabase/functions/fin-valor-engine/index.ts
// A2 — Retorno & Valor (ROIC/WACC/EVA). Master-only. Lê DRE TTM (fin_dre_snapshots),
// NCG (fin_projecao_snapshots.ncg) e inputs manuais (fin_config_cashflow.valor_inputs),
// e devolve o bloco "valor" por empresa. Helpers espelhados VERBATIM de src/lib/financeiro/valor-helpers.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function unauthorized(message = "Unauthorized"): Response {
  return jsonResponse({ error: message }, 401);
}

// Master-only.
async function authorizeMaster(req: Request): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, response: unauthorized() };
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) return { ok: true };
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SERVICE_ROLE } });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };
    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return { ok: false, response: unauthorized() };
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    if (roles.some((r) => r.role === "master")) return { ok: true };
    return { ok: false, response: unauthorized("Forbidden — master only") };
  } catch {
    return { ok: false, response: unauthorized() };
  }
}

// ===================== Helpers espelhados (verbatim de valor-helpers.ts) =====================
type RegimeTributario = "simples" | "presumido";
const REGIME_POR_EMPRESA: Record<string, RegimeTributario> = { colacor: "presumido", oben: "presumido", colacor_sc: "simples" };

type NopatInput = {
  regime: RegimeTributario; resultado_operacional_ttm: number; receitas_financeiras_ttm: number; despesas_financeiras_ttm: number;
  irpj_ttm: number; csll_ttm: number; das_ttm: number; pis_ttm: number; cofins_ttm: number; icms_ttm: number; iss_ttm: number; ipi_ttm: number;
};
function calcularNOPAT(input: NopatInput) {
  const ebit = input.resultado_operacional_ttm - input.receitas_financeiras_ttm + input.despesas_financeiras_ttm;
  const imposto_operacional_nopat = input.regime === "presumido" ? input.irpj_ttm + input.csll_ttm : 0;
  const nopat = ebit - imposto_operacional_nopat;
  const carga_tributaria_regime_total = input.regime === "simples"
    ? input.das_ttm
    : input.irpj_ttm + input.csll_ttm + input.pis_ttm + input.cofins_ttm + input.icms_ttm + input.iss_ttm + input.ipi_ttm;
  return { ebit, imposto_operacional_nopat, nopat, carga_tributaria_regime_total };
}
function margemOperacionalPreImposto(input: { ebit: number; receita_liquida: number }): number {
  if (input.receita_liquida <= 0) return 0;
  return input.ebit / input.receita_liquida;
}
type AtivoFixoInput = { valor: number; data_ref: string | null; fonte: "book" | "avaliacao" | "reposicao" | "seguro" | null; base: "reposicao" | "book" | null; operacional: boolean } | null;
function capitalInvestido(input: { capital_giro: number; ativo_fixo: AtivoFixoInput; ajustes?: number }) {
  const ajustes = input.ajustes ?? 0;
  const motivos: string[] = [];
  let ativo_fixo = 0; let parcial = false;
  if (input.ativo_fixo && input.ativo_fixo.operacional && Number.isFinite(input.ativo_fixo.valor)) ativo_fixo = input.ativo_fixo.valor;
  else { parcial = true; motivos.push("Ativo fixo operacional não informado — capital investido parcial (só giro − ajustes)."); }
  const capital_investido = input.capital_giro + ativo_fixo - ajustes;
  return { capital_investido, capital_giro: input.capital_giro, ativo_fixo, ajustes, parcial, motivos };
}
type KeDecomposto = { ancora: number; premio_risco_equity: number; premio_tamanho_private: number; premio_iliquidez_controle: number };
function somarKe(d: KeDecomposto): number { return d.ancora + d.premio_risco_equity + d.premio_tamanho_private + d.premio_iliquidez_controle; }
function waccHurdle(input: { ke: number | null; kd: number | null; divida: number | null; equity: number | null }) {
  const motivos: string[] = [];
  const base = { wacc: null as number | null, ke: input.ke, kd: input.kd, peso_divida: null as number | null, peso_equity: null as number | null, tax_shield_aplicado: false as const, motivos };
  if (input.ke == null) { motivos.push("Ke não informado — WACC indisponível."); return base; }
  if (input.equity == null) { motivos.push("PL (equity) não informado — WACC indisponível."); return base; }
  if (input.divida == null) { motivos.push("Dívida não informada — WACC indisponível."); return base; }
  const total = input.divida + input.equity;
  if (total <= 0) { motivos.push("Dívida + PL ≤ 0 — WACC indisponível."); return base; }
  if (input.divida > 0 && input.kd == null) { motivos.push("Há dívida mas Kd não informado — WACC indisponível."); return base; }
  const peso_divida = input.divida / total; const peso_equity = 1 - peso_divida; const kd = input.kd ?? 0;
  const wacc = peso_equity * input.ke + peso_divida * kd;
  return { wacc, ke: input.ke, kd: input.kd, peso_divida, peso_equity, tax_shield_aplicado: false as const, motivos };
}
function roic(input: { nopat: number; capital_investido: number | null }): number | null {
  if (input.capital_investido == null || input.capital_investido <= 0) return null;
  return input.nopat / input.capital_investido;
}
function spread(input: { roic: number | null; wacc: number | null }): number | null {
  if (input.roic == null || input.wacc == null) return null;
  return input.roic - input.wacc;
}
function eva(input: { spread: number | null; capital_investido: number | null }): number | null {
  if (input.spread == null || input.capital_investido == null) return null;
  return input.spread * input.capital_investido;
}
function roicIncremental(input: { nopat_atual: number; nopat_anterior: number | null; capital_atual: number | null; capital_anterior: number | null; limiar_delta_capital?: number }) {
  const limiar = input.limiar_delta_capital ?? 1000;
  if (input.nopat_anterior == null || input.capital_atual == null || input.capital_anterior == null) {
    return { roic_incremental: null, delta_nopat: null, delta_capital: null, aviso: "Histórico insuficiente (precisa de NOPAT e capital do TTM atual e do TTM −12m)." };
  }
  const delta_nopat = input.nopat_atual - input.nopat_anterior;
  const delta_capital = input.capital_atual - input.capital_anterior;
  if (delta_capital < limiar) return { roic_incremental: null, delta_nopat, delta_capital, aviso: "Variação de capital pequena ou negativa — ROIC incremental seria ruído." };
  return { roic_incremental: delta_nopat / delta_capital, delta_nopat, delta_capital, aviso: null };
}
function normalizarComingling(input: { ebit_reportado: number; capital_reportado: number; prolabore_real_ttm: number | null; prolabore_mercado_ttm: number | null; aluguel_mercado_ttm: number | null; intercompany_giro: number | null }) {
  const motivos: string[] = []; let aplicado = false;
  let ajuste_prolabore = 0;
  if (input.prolabore_real_ttm != null && input.prolabore_mercado_ttm != null) { ajuste_prolabore = input.prolabore_real_ttm - input.prolabore_mercado_ttm; aplicado = true; }
  else motivos.push("Pró-labore real/mercado não informado — sem normalização de pró-labore.");
  let ajuste_aluguel = 0;
  if (input.aluguel_mercado_ttm != null) { ajuste_aluguel = -input.aluguel_mercado_ttm; aplicado = true; }
  else motivos.push("Aluguel de mercado não informado — sem normalização de aluguel.");
  let ajuste_intercompany_capital = 0;
  if (input.intercompany_giro != null) { ajuste_intercompany_capital = -input.intercompany_giro; aplicado = true; }
  const ebit_normalizado = input.ebit_reportado + ajuste_prolabore + ajuste_aluguel;
  const capital_normalizado = input.capital_reportado + ajuste_intercompany_capital;
  if (!aplicado) motivos.push("Sem inputs de normalização — só visão reportada; possível comingling do dono não ajustado.");
  return { ebit_reportado: input.ebit_reportado, ebit_normalizado, capital_reportado: input.capital_reportado, capital_normalizado, ajuste_prolabore, ajuste_aluguel, ajuste_intercompany_capital, aplicado, motivos };
}
function scoreConfiancaValor(input: { roic_null: boolean; wacc_null: boolean; eva_null: boolean; capital_parcial: boolean; normalizacao_aplicada: boolean; imposto_teorico_parcial: boolean; dre_confianca: "alta" | "media" | "baixa" }) {
  const motivos: string[] = []; let nivel = 3;
  const rebaixar = (para: number, motivo: string) => { if (para < nivel) nivel = para; motivos.push(motivo); };
  if (input.capital_parcial) rebaixar(2, "Capital investido parcial (sem ativo fixo) — ROIC/EVA parciais.");
  if (input.wacc_null) rebaixar(2, "WACC/EVA/spread indisponíveis (faltam dívida, PL ou Ke).");
  if (!input.normalizacao_aplicada) rebaixar(2, "Sem normalização de comingling — só visão reportada.");
  if (input.imposto_teorico_parcial) rebaixar(2, "Config tributária incompleta — imposto operacional parcial (propaga da Onda 3).");
  if (input.dre_confianca === "baixa") rebaixar(1, "DRE subjacente com confiança baixa.");
  else if (input.dre_confianca === "media") rebaixar(2, "DRE subjacente com confiança média.");
  if (input.roic_null) rebaixar(2, "ROIC indisponível (capital investido ≤ 0).");
  return {
    nivel: (nivel === 3 ? "alta" : nivel === 2 ? "media" : "baixa") as "alta" | "media" | "baixa",
    motivos, roic_disponivel: !input.roic_null, wacc_disponivel: !input.wacc_null, eva_disponivel: !input.eva_null, normalizado_disponivel: input.normalizacao_aplicada,
  };
}

// ===================== Leitura de DB + orquestração =====================
type Company = "oben" | "colacor" | "colacor_sc";
type Input = { company: Company };

// Snapshot mensal da DRE (subset usado)
type DreRow = {
  ano: number; mes: number;
  receita_liquida: number; resultado_operacional: number; receitas_financeiras: number; despesas_financeiras: number;
  detalhamento: { impostos?: Record<string, number>; confianca?: { nivel?: "alta" | "media" | "baixa" } } | null;
};

function somaJanela(rows: DreRow[], idxFim: number, meses = 12) {
  // janela [idxFim − (meses−1), idxFim] inclusiva, por ano*12+mes
  const acc = {
    receita_liquida: 0, resultado_operacional: 0, receitas_financeiras: 0, despesas_financeiras: 0,
    irpj: 0, csll: 0, das: 0, ded_pis: 0, ded_cofins: 0, ded_icms: 0, ded_iss: 0, ded_ipi: 0,
    confianca_pior: 3, count: 0,
  };
  const nivelNum = (n?: string) => (n === "baixa" ? 1 : n === "media" ? 2 : 3);
  for (const r of rows) {
    const idx = r.ano * 12 + r.mes;
    if (idx < idxFim - (meses - 1) || idx > idxFim) continue;
    acc.count++;
    acc.receita_liquida += r.receita_liquida ?? 0;
    acc.resultado_operacional += r.resultado_operacional ?? 0;
    acc.receitas_financeiras += r.receitas_financeiras ?? 0;
    acc.despesas_financeiras += r.despesas_financeiras ?? 0;
    const imp = r.detalhamento?.impostos ?? {};
    acc.irpj += imp.irpj ?? 0; acc.csll += imp.csll ?? 0; acc.das += imp.das ?? 0;
    acc.ded_pis += imp.ded_pis ?? 0; acc.ded_cofins += imp.ded_cofins ?? 0; acc.ded_icms += imp.ded_icms ?? 0;
    acc.ded_iss += imp.ded_iss ?? 0; acc.ded_ipi += imp.ded_ipi ?? 0;
    const n = nivelNum(r.detalhamento?.confianca?.nivel);
    if (n < acc.confianca_pior) acc.confianca_pior = n;
  }
  return acc;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeMaster(req);
  if (!auth.ok) return auth.response;

  let payload: Input;
  try { payload = await req.json(); } catch { return jsonResponse({ error: "invalid JSON" }, 400); }
  const company = payload.company;
  if (!company) return jsonResponse({ error: "company obrigatório" }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 1) Config: regime + valor_inputs (defensivo)
  const { data: cfgRaw } = await db.from("fin_config_cashflow")
    .select("dre_tributario, valor_inputs").eq("company", company).maybeSingle();
  const cfg = (cfgRaw ?? {}) as { dre_tributario?: { regime?: RegimeTributario; anexo?: string } | null; valor_inputs?: Record<string, unknown> | null };
  const regime: RegimeTributario = (cfg.dre_tributario?.regime as RegimeTributario) ?? REGIME_POR_EMPRESA[company] ?? "presumido";
  const vi = (cfg.valor_inputs ?? {}) as Record<string, any>;
  // Config tributária completa? (propaga rebaixamento de confiança da Onda 3b)
  const configCompleta = regime === "presumido" ? cfg.dre_tributario != null : (cfg.dre_tributario?.anexo != null);
  const imposto_teorico_parcial = !configCompleta;

  // 2) DRE TTM (regime competência)
  const { data: dreRows } = await db.from("fin_dre_snapshots")
    .select("ano, mes, receita_liquida, resultado_operacional, receitas_financeiras, despesas_financeiras, detalhamento")
    .eq("company", company).eq("regime", "competencia");
  const rows = (dreRows ?? []) as DreRow[];
  if (rows.length === 0) {
    return jsonResponse({ error: "Sem snapshots de DRE (competência) para esta empresa. Rode a DRE primeiro." }, 422);
  }
  const idxFim = Math.max(...rows.map((r) => r.ano * 12 + r.mes));
  const ttm = somaJanela(rows, idxFim, 12);
  const ttmAnterior = somaJanela(rows, idxFim - 12, 12);
  const ano_mes_fim = `${Math.floor(idxFim / 12)}-${String(((idxFim - 1) % 12) + 1).padStart(2, "0")}`;
  const dre_confianca: "alta" | "media" | "baixa" = ttm.confianca_pior === 1 ? "baixa" : ttm.confianca_pior === 2 ? "media" : "alta";

  // 3) Capital de giro: último ncg snapshot + ncg ~365d antes
  const { data: snaps } = await db.from("fin_projecao_snapshots")
    .select("ncg, snapshot_at").eq("company", company).order("snapshot_at", { ascending: false }).limit(400);
  const snapRows = (snaps ?? []) as Array<{ ncg: number | null; snapshot_at: string }>;
  const capital_giro = snapRows.length > 0 && snapRows[0].ncg != null ? Number(snapRows[0].ncg) : 0;
  let capital_giro_anterior: number | null = null;
  if (snapRows.length > 0) {
    const alvo = new Date(snapRows[0].snapshot_at).getTime() - 365 * 86400000;
    let melhor: { ncg: number | null; dist: number } | null = null;
    for (const s of snapRows) {
      if (s.ncg == null) continue;
      const dist = Math.abs(new Date(s.snapshot_at).getTime() - alvo);
      if (melhor == null || dist < melhor.dist) melhor = { ncg: s.ncg, dist };
    }
    // só aceita se o snapshot encontrado está a ≤ 60 dias do alvo (senão não há histórico real de 12m)
    if (melhor && melhor.dist <= 60 * 86400000) capital_giro_anterior = Number(melhor.ncg);
  }

  // 4) Inputs manuais (mensais → TTM via ×12)
  const numOrNull = (x: unknown): number | null => (x == null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
  const ativo_fixo: AtivoFixoInput = vi.ativo_fixo && numOrNull(vi.ativo_fixo.valor) != null
    ? { valor: Number(vi.ativo_fixo.valor), data_ref: vi.ativo_fixo.data_ref ?? null, fonte: vi.ativo_fixo.fonte ?? null, base: vi.ativo_fixo.base ?? null, operacional: vi.ativo_fixo.operacional !== false }
    : null;
  const ajustes = Number(vi.ajustes ?? 0);
  const divida = numOrNull(vi.divida);
  const equity = numOrNull(vi.equity);
  const kd = numOrNull(vi.kd);
  const keCen = (vi.ke ?? {}) as Record<string, KeDecomposto | undefined>;
  const keBase = keCen.base ?? null;
  const prolabore_real_ttm = numOrNull(vi.prolabore_real_mensal) != null ? Number(vi.prolabore_real_mensal) * 12 : null;
  const prolabore_mercado_ttm = numOrNull(vi.prolabore_mercado_mensal) != null ? Number(vi.prolabore_mercado_mensal) * 12 : null;
  const aluguel_mercado_ttm = numOrNull(vi.aluguel_mercado_mensal) != null ? Number(vi.aluguel_mercado_mensal) * 12 : null;
  const intercompany_giro = numOrNull(vi.intercompany_giro);

  // 5) NOPAT (atual + anterior)
  const nopatIn = (j: typeof ttm): NopatInput => ({
    regime,
    resultado_operacional_ttm: j.resultado_operacional, receitas_financeiras_ttm: j.receitas_financeiras, despesas_financeiras_ttm: j.despesas_financeiras,
    irpj_ttm: j.irpj, csll_ttm: j.csll, das_ttm: j.das, pis_ttm: j.ded_pis, cofins_ttm: j.ded_cofins, icms_ttm: j.ded_icms, iss_ttm: j.ded_iss, ipi_ttm: j.ded_ipi,
  });
  const nopatAtual = calcularNOPAT(nopatIn(ttm));
  const nopatAnterior = ttmAnterior.count >= 12 ? calcularNOPAT(nopatIn(ttmAnterior)) : null;

  // 6) Capital investido (reportado) — AF cancela no incremental (mesmo AF nos dois pontos)
  const capRep = capitalInvestido({ capital_giro, ativo_fixo, ajustes });
  const capAnterior = capital_giro_anterior != null ? capitalInvestido({ capital_giro: capital_giro_anterior, ativo_fixo, ajustes }).capital_investido : null;

  // 7) WACC (base + cenários)
  const waccDe = (ke: KeDecomposto | null | undefined) => waccHurdle({ ke: ke ? somarKe(ke) : null, kd, divida, equity });
  const waccBase = waccDe(keBase);
  const wacc_cenarios = {
    conservador: waccDe(keCen.conservador).wacc,
    base: waccBase.wacc,
    agressivo: waccDe(keCen.agressivo).wacc,
  };

  // 8) ROIC/spread/EVA (reportado)
  const roicRep = roic({ nopat: nopatAtual.nopat, capital_investido: capRep.capital_investido });
  const spreadRep = spread({ roic: roicRep, wacc: waccBase.wacc });
  const evaRep = eva({ spread: spreadRep, capital_investido: capRep.capital_investido });
  const incremental = roicIncremental({ nopat_atual: nopatAtual.nopat, nopat_anterior: nopatAnterior?.nopat ?? null, capital_atual: capRep.capital_investido, capital_anterior: capAnterior });

  // 9) Normalização (comingling) → NOPAT/ROIC/EVA normalizados
  const cg = normalizarComingling({
    ebit_reportado: nopatAtual.ebit, capital_reportado: capRep.capital_investido,
    prolabore_real_ttm, prolabore_mercado_ttm, aluguel_mercado_ttm, intercompany_giro,
  });
  const impostoNorm = regime === "presumido" ? nopatAtual.imposto_operacional_nopat : 0;
  const nopatNorm = cg.ebit_normalizado - impostoNorm;
  const roicNorm = roic({ nopat: nopatNorm, capital_investido: cg.capital_normalizado });
  const spreadNorm = spread({ roic: roicNorm, wacc: waccBase.wacc });
  const evaNorm = eva({ spread: spreadNorm, capital_investido: cg.capital_normalizado });

  // 10) Confiança
  const confianca = scoreConfiancaValor({
    roic_null: roicRep == null, wacc_null: waccBase.wacc == null, eva_null: evaRep == null,
    capital_parcial: capRep.parcial, normalizacao_aplicada: cg.aplicado, imposto_teorico_parcial, dre_confianca,
  });

  const result = {
    company, regime,
    ttm: { ano_mes_fim, meses: ttm.count, tem_anterior: nopatAnterior != null && capAnterior != null },
    reportado: {
      ebit: nopatAtual.ebit, nopat: nopatAtual.nopat,
      imposto_operacional_nopat: nopatAtual.imposto_operacional_nopat,
      carga_tributaria_regime_total: nopatAtual.carga_tributaria_regime_total,
      margem_operacional_pre_imposto: margemOperacionalPreImposto({ ebit: nopatAtual.ebit, receita_liquida: ttm.receita_liquida }),
      receita_liquida_ttm: ttm.receita_liquida,
      capital_investido: capRep.capital_investido, capital_giro: capRep.capital_giro, ativo_fixo: capRep.ativo_fixo, ajustes: capRep.ajustes, capital_parcial: capRep.parcial,
      roic: roicRep, wacc: waccBase.wacc, spread: spreadRep, eva: evaRep,
      roic_incremental: incremental.roic_incremental,
      incremental: { delta_nopat: incremental.delta_nopat, delta_capital: incremental.delta_capital, aviso: incremental.aviso },
      wacc_cenarios, peso_divida: waccBase.peso_divida, peso_equity: waccBase.peso_equity,
    },
    normalizado: {
      ebit: cg.ebit_normalizado, nopat: nopatNorm, capital_investido: cg.capital_normalizado,
      roic: roicNorm, spread: spreadNorm, eva: evaNorm,
      ajuste_prolabore: cg.ajuste_prolabore, ajuste_aluguel: cg.ajuste_aluguel, ajuste_intercompany_capital: cg.ajuste_intercompany_capital,
      aplicado: cg.aplicado,
    },
    confianca,
    motivos: [...capRep.motivos, ...waccBase.motivos, ...cg.motivos],
  };
  return jsonResponse(result, 200);
});
