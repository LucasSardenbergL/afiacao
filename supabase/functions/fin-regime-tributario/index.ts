// supabase/functions/fin-regime-tributario/index.ts
// Otimizador Tributário — comparador de regime (Simples × Presumido × Real) por empresa + consolidado.
// Master-only. Lê DRE TTM (fin_dre_snapshots, regime competência) + inputs manuais (fin_regime_inputs).
// Helpers espelhados VERBATIM de src/lib/financeiro/regime-tributario-helpers.ts (+ dre-tabelas-tributarias.ts
// e aliquotaEfetivaSimples/faixaPorRBT12 de dre-helpers.ts). Estilo de leitura espelhado de fin-valor-engine.
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

// ===================== Tabelas legais (verbatim de dre-tabelas-tributarias.ts) =====================
type AnexoSimples = "I" | "II" | "III" | "IV" | "V";
type FaixaSimples = { ate: number; aliquota: number; deduzir: number };

const ANEXOS_SIMPLES: Record<AnexoSimples, FaixaSimples[]> = {
  // Anexo I — Comércio
  I: [
    { ate: 180000, aliquota: 0.04, deduzir: 0 },
    { ate: 360000, aliquota: 0.073, deduzir: 5940 },
    { ate: 720000, aliquota: 0.095, deduzir: 13860 },
    { ate: 1800000, aliquota: 0.107, deduzir: 22500 },
    { ate: 3600000, aliquota: 0.143, deduzir: 87300 },
    { ate: 4800000, aliquota: 0.19, deduzir: 378000 },
  ],
  // Anexo II — Indústria
  II: [
    { ate: 180000, aliquota: 0.045, deduzir: 0 },
    { ate: 360000, aliquota: 0.078, deduzir: 5940 },
    { ate: 720000, aliquota: 0.10, deduzir: 13860 },
    { ate: 1800000, aliquota: 0.112, deduzir: 22500 },
    { ate: 3600000, aliquota: 0.147, deduzir: 85500 },
    { ate: 4800000, aliquota: 0.30, deduzir: 720000 },
  ],
  // Anexo III — Serviços (fator-r ≥ 28%)
  III: [
    { ate: 180000, aliquota: 0.06, deduzir: 0 },
    { ate: 360000, aliquota: 0.112, deduzir: 9360 },
    { ate: 720000, aliquota: 0.135, deduzir: 17640 },
    { ate: 1800000, aliquota: 0.16, deduzir: 35640 },
    { ate: 3600000, aliquota: 0.21, deduzir: 125640 },
    { ate: 4800000, aliquota: 0.33, deduzir: 648000 },
  ],
  // Anexo IV — Serviços (limpeza/vigilância/construção/advocacia)
  IV: [
    { ate: 180000, aliquota: 0.045, deduzir: 0 },
    { ate: 360000, aliquota: 0.09, deduzir: 8100 },
    { ate: 720000, aliquota: 0.102, deduzir: 12420 },
    { ate: 1800000, aliquota: 0.14, deduzir: 39780 },
    { ate: 3600000, aliquota: 0.22, deduzir: 183780 },
    { ate: 4800000, aliquota: 0.33, deduzir: 828000 },
  ],
  // Anexo V — Serviços (fator-r < 28%)
  V: [
    { ate: 180000, aliquota: 0.155, deduzir: 0 },
    { ate: 360000, aliquota: 0.18, deduzir: 4500 },
    { ate: 720000, aliquota: 0.195, deduzir: 9900 },
    { ate: 1800000, aliquota: 0.205, deduzir: 17100 },
    { ate: 3600000, aliquota: 0.23, deduzir: 62100 },
    { ate: 4800000, aliquota: 0.305, deduzir: 540000 },
  ],
};

// Lucro presumido (cumulativo): IRPJ 15% + adicional 10% sobre o que exceder R$60k/trimestre,
// CSLL 9%, PIS 0,65%, COFINS 3%.
const PRESUMIDO = {
  irpj_aliquota: 0.15,
  irpj_adicional_aliquota: 0.10,
  irpj_adicional_limite_trimestral: 60000,
  csll_aliquota: 0.09,
  pis_aliquota: 0.0065,
  cofins_aliquota: 0.03,
};

// Limiar do Fator-R: ≥28% folha/receita → Anexo III; < 28% → Anexo V.
const FATOR_R_LIMIAR = 0.28;

// ===================== faixaPorRBT12 + aliquotaEfetivaSimples (verbatim de dre-helpers.ts) =====================
function faixaPorRBT12(anexo: AnexoSimples, rbt12: number): FaixaSimples {
  const faixas = ANEXOS_SIMPLES[anexo];
  for (const f of faixas) {
    if (rbt12 <= f.ate) return f;
  }
  return faixas[faixas.length - 1];
}

// Alíquota efetiva do Simples: (RBT12 × nominal − parcela a deduzir) / RBT12.
function aliquotaEfetivaSimples(anexo: AnexoSimples, rbt12: number): number {
  if (rbt12 <= 0) return 0;
  const f = faixaPorRBT12(anexo, rbt12);
  const efetiva = (rbt12 * f.aliquota - f.deduzir) / rbt12;
  return Math.max(0, efetiva);
}

// ===================== Comparador de regime (verbatim de regime-tributario-helpers.ts) =====================
type PartilhaFaixa = { irpj: number; csll: number; cofins: number; pis: number; cpp: number; icms: number; iss: number; ipi: number };
const PARTILHA_SIMPLES: Record<"I" | "II" | "III" | "V", PartilhaFaixa[]> = {
  I: [
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.415, icms: 0.34, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.415, icms: 0.34, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.42,  icms: 0.335, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.42,  icms: 0.335, iss: 0, ipi: 0 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1274, pis: 0.0276, cpp: 0.42,  icms: 0.335, iss: 0, ipi: 0 },
    { irpj: 0.135, csll: 0.10,  cofins: 0.2827, pis: 0.0613, cpp: 0.421, icms: 0,     iss: 0, ipi: 0 },
  ],
  II: [
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.055, csll: 0.035, cofins: 0.1151, pis: 0.0249, cpp: 0.375, icms: 0.32, iss: 0, ipi: 0.075 },
    { irpj: 0.085, csll: 0.075, cofins: 0.2096, pis: 0.0454, cpp: 0.235, icms: 0,    iss: 0, ipi: 0.35 },
  ],
  III: [
    { irpj: 0.04, csll: 0.035, cofins: 0.1282, pis: 0.0278, cpp: 0.434, icms: 0, iss: 0.335, ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1405, pis: 0.0305, cpp: 0.434, icms: 0, iss: 0.32,  ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1364, pis: 0.0296, cpp: 0.434, icms: 0, iss: 0.325, ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1364, pis: 0.0296, cpp: 0.434, icms: 0, iss: 0.325, ipi: 0 },
    { irpj: 0.04, csll: 0.035, cofins: 0.1282, pis: 0.0278, cpp: 0.434, icms: 0, iss: 0.335, ipi: 0 },
    { irpj: 0.35, csll: 0.15,  cofins: 0.1603, pis: 0.0347, cpp: 0.305, icms: 0, iss: 0,     ipi: 0 },
  ],
  V: [
    { irpj: 0.25, csll: 0.15,  cofins: 0.141,  pis: 0.0305, cpp: 0.2885, icms: 0, iss: 0.14,  ipi: 0 },
    { irpj: 0.23, csll: 0.15,  cofins: 0.141,  pis: 0.0305, cpp: 0.2785, icms: 0, iss: 0.17,  ipi: 0 },
    { irpj: 0.24, csll: 0.15,  cofins: 0.1492, pis: 0.0323, cpp: 0.2385, icms: 0, iss: 0.19,  ipi: 0 },
    { irpj: 0.21, csll: 0.15,  cofins: 0.1574, pis: 0.0341, cpp: 0.2385, icms: 0, iss: 0.21,  ipi: 0 },
    { irpj: 0.23, csll: 0.125, cofins: 0.141,  pis: 0.0305, cpp: 0.2385, icms: 0, iss: 0.235, ipi: 0 },
    { irpj: 0.35, csll: 0.155, cofins: 0.1644, pis: 0.0356, cpp: 0.295,  icms: 0, iss: 0,     ipi: 0 },
  ],
};

const TETO_ISS = 0.05;
const SUBLIMITE_RBA = 3_600_000;
const TETO_RBA = 4_800_000;

// Returns the faixa index where rbt12 falls; defensively returns last faixa index when rbt12 exceeds all ceilings.
function indiceFaixa(anexo: AnexoSimples, rbt12: number): number {
  const faixas = ANEXOS_SIMPLES[anexo];
  for (let i = 0; i < faixas.length; i++) { if (rbt12 <= faixas[i].ate) return i; }
  return faixas.length - 1;
}

function partilhaIndiretoFrac(anexo: "I" | "II" | "III" | "V", rbt12: number, efetiva: number): number {
  const p = PARTILHA_SIMPLES[anexo][indiceFaixa(anexo, rbt12)];
  let iss_frac = efetiva * p.iss;
  if (iss_frac > TETO_ISS) iss_frac = TETO_ISS;
  return efetiva * (p.icms + p.ipi) + iss_frac;
}

type ImpostoSimples = { total_federal_cpp: number; das_total: number; icms_iss_ipi: number; aproximado: boolean };
function impostoAnualSimples(input: { anexo: "I" | "II" | "III" | "V"; rbt12: number; receitaAnual: number }): ImpostoSimples {
  const efetiva = aliquotaEfetivaSimples(input.anexo, input.rbt12);
  const das_total = efetiva * input.receitaAnual;
  const indireto_frac = partilhaIndiretoFrac(input.anexo, input.rbt12, efetiva);
  const icms_iss_ipi = indireto_frac * input.receitaAnual;
  return { total_federal_cpp: das_total - icms_iss_ipi, das_total, icms_iss_ipi, aproximado: true };
}

type Elegibilidade = { status_elegibilidade: "elegivel" | "sublimite_excedido" | "inelegivel"; motivo_inelegivel: string | null };
function elegibilidadeSimples(rba: number): Elegibilidade {
  if (rba > TETO_RBA) return { status_elegibilidade: "inelegivel", motivo_inelegivel: `RBA R$ ${(rba / 1e6).toFixed(2)}M > teto R$ 4,8M do Simples.` };
  if (rba > SUBLIMITE_RBA) return { status_elegibilidade: "sublimite_excedido", motivo_inelegivel: null };
  return { status_elegibilidade: "elegivel", motivo_inelegivel: null };
}

const IRPJ_ADIC_LIMITE_TRIM = PRESUMIDO.irpj_adicional_limite_trimestral; // 60000
const ADIC = PRESUMIDO.irpj_adicional_aliquota; // 0.10
const IRPJ = PRESUMIDO.irpj_aliquota;           // 0.15
const CSLL = PRESUMIDO.csll_aliquota;           // 0.09
const PIS_COFINS_NAO_CUMULATIVO = 0.0925;       // 1,65% + 7,6%
const PIS_COFINS_FINANCEIRO = 0.0465;           // 0,65% + 4% (Decreto 8.426/2015) — só no não-cumulativo

function encargoPatronal(folhaCppAnual: number | null, pct: number): number | null {
  if (folhaCppAnual == null) return null;
  return folhaCppAnual * pct;
}

type ImpostoPresumido = { irpj: number; csll: number; pis: number; cofins: number; cpp: number; total_federal_cpp: number };
function impostoAnualPresumido(input: {
  trimestres: number[]; presuncaoIrpj: number; presuncaoCsll: number;
  receitasFinanceiras: number; folhaCppAnual: number | null; encargoPct: number;
}): ImpostoPresumido {
  let irpj = 0, csll = 0;
  const receitaAno = input.trimestres.reduce((s, t) => s + t, 0);
  const recFinPorTrim = input.receitasFinanceiras / 4; // receita financeira entra integral na base
  for (const recTrim of input.trimestres) {
    const baseIrpj = recTrim * input.presuncaoIrpj + recFinPorTrim;
    irpj += baseIrpj * IRPJ + Math.max(0, baseIrpj - IRPJ_ADIC_LIMITE_TRIM) * ADIC;
    csll += (recTrim * input.presuncaoCsll + recFinPorTrim) * CSLL;
  }
  // PIS/COFINS cumulativo: receita operacional (excluídas receitas financeiras), alíquota-zero no cumulativo (Decreto 8.426/2015)
  const pis = receitaAno * PRESUMIDO.pis_aliquota, cofins = receitaAno * PRESUMIDO.cofins_aliquota;
  const cpp = encargoPatronal(input.folhaCppAnual, input.encargoPct) ?? 0;
  return { irpj, csll, pis, cofins, cpp, total_federal_cpp: irpj + csll + pis + cofins + cpp };
}

type ImpostoReal = { irpj: number; csll: number; pis_cofins: number; cpp: number; total_federal_cpp: number; credito_aplicado: number; lucro_usado: number };
function impostoAnualReal(input: {
  lucroAnual: number; lucroTrimestres: number[]; receitaTributavel: number; receitasFinanceiras: number;
  creditoPct: number; folhaCppAnual: number | null; encargoPct: number;
}): ImpostoReal {
  let irpj = 0, csll = 0;
  for (const lt of input.lucroTrimestres) {
    if (lt <= 0) continue;
    irpj += lt * IRPJ + Math.max(0, lt - IRPJ_ADIC_LIMITE_TRIM) * ADIC;
    csll += lt * CSLL;
  }
  const credito = input.receitaTributavel * PIS_COFINS_NAO_CUMULATIVO * input.creditoPct;
  const pis_cofins = input.receitaTributavel * PIS_COFINS_NAO_CUMULATIVO - credito + input.receitasFinanceiras * PIS_COFINS_FINANCEIRO;
  const cpp = encargoPatronal(input.folhaCppAnual, input.encargoPct) ?? 0;
  return { irpj, csll, pis_cofins, cpp, total_federal_cpp: irpj + csll + pis_cofins + cpp, credito_aplicado: credito, lucro_usado: input.lucroAnual };
}

function anexoEfetivoFatorR(massaFatorR: number | null, receita: number): { anexo: "III" | "V"; fator_r: number | null; banda: boolean } {
  if (massaFatorR == null || receita <= 0) return { anexo: "V", fator_r: null, banda: true };
  const fr = massaFatorR / receita;
  return { anexo: fr >= FATOR_R_LIMIAR ? "III" : "V", fator_r: fr, banda: false };
}

// Margem líquida (lucro/receita) abaixo da qual o IRPJ/CSLL do Real fica menor que o do Presumido (direcional).
function breakEvenMargemReal(input: { presuncaoIrpj: number; presuncaoCsll: number }): number {
  return (input.presuncaoIrpj * IRPJ + input.presuncaoCsll * CSLL) / (IRPJ + CSLL);
}

type RegimeNome = "simples" | "presumido" | "real";
type StatusElegibilidade = "elegivel" | "sublimite_excedido" | "inelegivel";
type StatusRecomendacao = "recomenda" | "empate_tecnico" | "manter" | "incompleto";
type RegimeComparado = {
  regime: RegimeNome; elegivel: boolean; status_elegibilidade: StatusElegibilidade; motivo_inelegivel: string | null;
  total_federal_cpp: number; aliquota_efetiva: number | null; detalhe: Record<string, number>; aproximado: boolean; flags: string[];
};

function compararRegimes(input: {
  simples: ImpostoSimples; elegSimples: Elegibilidade;
  presumido: ImpostoPresumido; real: ImpostoReal; receitaAnual?: number;
}): RegimeComparado[] {
  const rec = input.receitaAnual && input.receitaAnual > 0 ? input.receitaAnual : null;
  const simplesElegivel = input.elegSimples.status_elegibilidade !== "inelegivel";
  const lista: RegimeComparado[] = [
    {
      regime: "simples", elegivel: simplesElegivel, status_elegibilidade: input.elegSimples.status_elegibilidade,
      motivo_inelegivel: input.elegSimples.motivo_inelegivel, total_federal_cpp: input.simples.total_federal_cpp,
      aliquota_efetiva: rec ? input.simples.total_federal_cpp / rec : null,
      detalhe: { das_total: input.simples.das_total, federal_cpp_do_das: input.simples.total_federal_cpp, icms_iss_ipi: input.simples.icms_iss_ipi },
      aproximado: input.simples.aproximado, flags: input.elegSimples.status_elegibilidade === "sublimite_excedido" ? ["Sublimite excedido — ICMS/ISS fora do DAS."] : [],
    },
    {
      regime: "presumido", elegivel: true, status_elegibilidade: "elegivel", motivo_inelegivel: null,
      total_federal_cpp: input.presumido.total_federal_cpp, aliquota_efetiva: rec ? input.presumido.total_federal_cpp / rec : null,
      detalhe: { irpj: input.presumido.irpj, csll: input.presumido.csll, pis: input.presumido.pis, cofins: input.presumido.cofins, cpp: input.presumido.cpp }, aproximado: false, flags: [],
    },
    {
      regime: "real", elegivel: true, status_elegibilidade: "elegivel", motivo_inelegivel: null,
      total_federal_cpp: input.real.total_federal_cpp, aliquota_efetiva: rec ? input.real.total_federal_cpp / rec : null,
      detalhe: { irpj: input.real.irpj, csll: input.real.csll, pis_cofins: input.real.pis_cofins, cpp: input.real.cpp, credito_aplicado: input.real.credito_aplicado },
      aproximado: true, flags: ["Lucro real ≈ resultado contábil (sem LALUR).", input.real.credito_aplicado === 0 ? "Crédito PIS/COFINS = 0 (faltam NCM/CFOP) — Real pode ser melhor." : ""].filter(Boolean),
    },
  ];
  return lista.sort((a, b) => {
    if (a.elegivel !== b.elegivel) return a.elegivel ? -1 : 1;
    return a.total_federal_cpp - b.total_federal_cpp;
  });
}

function recomendarRegime(comparados: RegimeComparado[], regimeAtual: RegimeNome, opts: { bandaErro: number; dadosCompletos?: boolean }):
  { recomendado: RegimeNome | null; economia_anual: number | null; status: StatusRecomendacao } {
  const elegiveis = comparados.filter((c) => c.elegivel);
  if (elegiveis.length === 0) return { recomendado: null, economia_anual: null, status: "incompleto" };
  const melhor = elegiveis[0];
  if (opts.dadosCompletos === false) {
    return { recomendado: melhor.regime, economia_anual: null, status: "incompleto" };
  }
  const atual = comparados.find((c) => c.regime === regimeAtual);
  const economia = atual ? atual.total_federal_cpp - melhor.total_federal_cpp : null;
  if (melhor.regime === regimeAtual) return { recomendado: regimeAtual, economia_anual: 0, status: "manter" };
  const segundo = elegiveis[1];
  const dentroBanda = segundo ? (segundo.total_federal_cpp - melhor.total_federal_cpp) / Math.max(1, segundo.total_federal_cpp) < opts.bandaErro : false;
  const status: StatusRecomendacao = (melhor.regime === "real" && dentroBanda) ? "empate_tecnico" : "recomenda";
  return { recomendado: melhor.regime, economia_anual: economia != null ? Math.max(0, economia) : null, status };
}

function scoreConfiancaRegime(input: { recomendado: RegimeNome | null; folhaConhecida: boolean; semFlagsFortes: boolean; ttmCompleto?: boolean }):
  { nivel: "alta" | "media" | "baixa"; motivos: string[] } {
  const motivos: string[] = [];
  let nivel = 3;
  const baixar = (p: number, m: string) => { if (p < nivel) nivel = p; motivos.push(m); };
  if (input.ttmCompleto === false) baixar(1, "TTM incompleto (<12 meses) — base anual não confiável.");
  if (input.recomendado === "real") baixar(2, "Lucro Real é triagem (sem LALUR/adições/exclusões) — confiança limitada.");
  if (!input.folhaConhecida) baixar(2, "Folha (CPP) não informada — comparação Simples × outros incompleta.");
  if (!input.semFlagsFortes) baixar(2, "Há flags de degradação (monofásico/ST/crédito não estimado).");
  return { nivel: nivel === 3 ? "alta" : nivel === 2 ? "media" : "baixa", motivos };
}

// ===================== Composição (engine) =====================
type Company = "colacor" | "oben" | "colacor_sc";
const EMPRESAS: Company[] = ["colacor", "oben", "colacor_sc"];
const REGIME_ATUAL_POR_EMPRESA: Record<Company, RegimeNome> = {
  colacor: "presumido",
  oben: "presumido",
  colacor_sc: "simples",
};

// Defaults por atividade — usados quando o input está ausente.
type DefaultsEmpresa = { anexo: "I" | "II" | "III" | "V"; fatorR: boolean; presuncaoIrpj: number; presuncaoCsll: number };
const DEFAULTS_POR_EMPRESA: Record<Company, DefaultsEmpresa> = {
  colacor: { anexo: "II", fatorR: false, presuncaoIrpj: 0.08, presuncaoCsll: 0.12 },       // indústria
  oben: { anexo: "I", fatorR: false, presuncaoIrpj: 0.08, presuncaoCsll: 0.12 },           // comércio
  colacor_sc: { anexo: "III", fatorR: true, presuncaoIrpj: 0.32, presuncaoCsll: 0.32 },    // serviços (fator-r)
};

const ENCARGO_PATRONAL_DEFAULT = 0.20;
const CREDITO_DEFAULT = 0;
const RECEITA_TRIBUTAVEL_PIS_COFINS_PCT_DEFAULT = 1;

// Snapshot mensal da DRE (subset usado). detalhamento não é necessário aqui.
type DreRow = {
  ano: number; mes: number;
  receita_bruta: number; receitas_financeiras: number; resultado_antes_impostos: number;
};

// Shape cru (defensivo) do JSONB regime_inputs.
type RegimeInputsRaw = {
  folha_cpp_anual?: unknown;
  massa_fator_r_anual?: unknown;
  encargo_patronal_pct?: unknown;
  presuncao_irpj?: unknown;
  presuncao_csll?: unknown;
  credito_pis_cofins_estimado?: unknown;
  receita_tributavel_pis_cofins_pct?: unknown;
  anexo_simples?: unknown;
};

function numOrNull(x: unknown): number | null {
  if (x == null || typeof x === "boolean" || Array.isArray(x)) return null;
  if (typeof x !== "number" && typeof x !== "string") return null;
  if (typeof x === "string" && x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null; // rejeita NaN e Infinity
}

type RegimeEmpresaResult = {
  empresa: string; regime_atual: RegimeNome; ttm: { ano_mes_fim: string; meses: number };
  comparados: RegimeComparado[]; recomendado: RegimeNome | null; economia_anual: number | null; status: StatusRecomendacao;
  break_even: { margem_real_vs_presumido: number | null; fator_r: number };
  eixo_indireto: { icms_iss_ipi_simples: number | null; observacao: string };
  confianca: { nivel: "alta" | "media" | "baixa"; motivos: string[] };
  regime_inputs: { folha_cpp_anual: number | null; massa_fator_r_anual: number | null; encargo_patronal_pct: number | null; presuncao_irpj: number | null; presuncao_csll: number | null; credito_pis_cofins_estimado: number | null; receita_tributavel_pis_cofins_pct: number | null; anexo_simples: string | null };
};
type RegimeTributarioResult = { por_empresa: RegimeEmpresaResult[]; consolidado: { imposto_atual_total: number; imposto_otimizado_total: number; economia_total: number; confianca: "alta" | "media" | "baixa" }; gerado_em: string };

type DbClient = ReturnType<typeof createClient>;

async function calcularEmpresa(db: DbClient, empresa: Company): Promise<RegimeEmpresaResult | null> {
  const regime_atual = REGIME_ATUAL_POR_EMPRESA[empresa];
  const defaults = DEFAULTS_POR_EMPRESA[empresa];

  // 1) DRE TTM (regime competência), ordenada por ano,mes
  const { data: dreRows } = await db.from("fin_dre_snapshots")
    .select("ano, mes, receita_bruta, receitas_financeiras, resultado_antes_impostos")
    .eq("company", empresa).eq("regime", "competencia")
    .order("ano", { ascending: true }).order("mes", { ascending: true });
  const allRows = (dreRows ?? []) as DreRow[];
  if (allRows.length === 0) return null;

  // Pega os 12 meses mais recentes (cronológico, ordenado por ano*12+mes).
  const sorted = [...allRows].sort((a, b) => (a.ano * 12 + a.mes) - (b.ano * 12 + b.mes));
  const window = sorted.slice(-12);
  const meses = window.length;
  const last = window[window.length - 1];
  const ano_mes_fim = `${last.ano}-${String(last.mes).padStart(2, "0")}`;

  const receita_bruta_ttm = window.reduce((s, r) => s + (r.receita_bruta ?? 0), 0);
  const receitas_financeiras_ttm = window.reduce((s, r) => s + (r.receitas_financeiras ?? 0), 0);
  const resultado_antes_impostos_ttm = window.reduce((s, r) => s + (r.resultado_antes_impostos ?? 0), 0);

  // Flags de nível-engine.
  const engineFlags: string[] = [];
  const ttm_incompleto = meses < 12;
  if (ttm_incompleto) engineFlags.push("TTM incompleto (anualização parcial).");

  // 2) Buckets trimestrais a partir da janela TTM (3 meses cada). Se <12, fallback TTM/4.
  let trimestresReceita: number[];
  let lucroTrimestres: number[];
  if (meses >= 12) {
    trimestresReceita = [0, 1, 2, 3].map((q) =>
      window.slice(q * 3, q * 3 + 3).reduce((s, r) => s + (r.receita_bruta ?? 0), 0));
    lucroTrimestres = [0, 1, 2, 3].map((q) =>
      window.slice(q * 3, q * 3 + 3).reduce((s, r) => s + (r.resultado_antes_impostos ?? 0), 0));
  } else {
    const recQ = receita_bruta_ttm / 4;
    const lucroQ = resultado_antes_impostos_ttm / 4;
    trimestresReceita = [recQ, recQ, recQ, recQ];
    lucroTrimestres = [lucroQ, lucroQ, lucroQ, lucroQ];
    engineFlags.push("trimestres aproximados (TTM/4).");
  }

  // 3) RBT12 e RBA (proxy por TTM).
  const rbt12 = receita_bruta_ttm;
  const rba = receita_bruta_ttm;
  engineFlags.push("RBA aproximada por TTM.");

  // 4) Parse inputs + defaults.
  const { data: inputsRow } = await db.from("fin_regime_inputs")
    .select("regime_inputs").eq("company", empresa).maybeSingle();
  const ri = ((inputsRow as { regime_inputs?: Record<string, unknown> } | null)?.regime_inputs ?? {}) as RegimeInputsRaw;

  const folhaCppAnual = numOrNull(ri.folha_cpp_anual);
  const massaFatorRAnual = numOrNull(ri.massa_fator_r_anual);
  const encargoPctIn = numOrNull(ri.encargo_patronal_pct);
  const encargoPct = encargoPctIn != null ? encargoPctIn : ENCARGO_PATRONAL_DEFAULT;
  const presuncaoIrpjIn = numOrNull(ri.presuncao_irpj);
  const presuncaoIrpj = presuncaoIrpjIn != null ? presuncaoIrpjIn : defaults.presuncaoIrpj;
  const presuncaoCsllIn = numOrNull(ri.presuncao_csll);
  const presuncaoCsll = presuncaoCsllIn != null ? presuncaoCsllIn : defaults.presuncaoCsll;
  const creditoIn = numOrNull(ri.credito_pis_cofins_estimado);
  const creditoPct = creditoIn != null ? creditoIn : CREDITO_DEFAULT;
  const recTribPctIn = numOrNull(ri.receita_tributavel_pis_cofins_pct);
  const receitaTributavelPct = recTribPctIn != null ? recTribPctIn : RECEITA_TRIBUTAVEL_PIS_COFINS_PCT_DEFAULT;
  const anexoStored = typeof ri.anexo_simples === "string" ? ri.anexo_simples : null;
  const anexoInput = anexoStored && ["I", "II", "III", "V"].includes(anexoStored)
    ? (anexoStored as "I" | "II" | "III" | "V") : null;
  // Flag honesto quando anexo armazenado não é suportado (ex.: IV recolhe CPP à parte).
  if (anexoStored && !anexoInput) {
    engineFlags.push(`Anexo "${anexoStored}" não suportado na comparação (ex.: IV recolhe CPP à parte) — usado o anexo padrão "${defaults.anexo}".`);
  }

  // 5) Determina anexo.
  let anexo: "I" | "II" | "III" | "V";
  if (empresa === "colacor_sc") {
    const efetivo = anexoEfetivoFatorR(massaFatorRAnual, receita_bruta_ttm);
    if (efetivo.banda) {
      anexo = anexoInput ?? defaults.anexo; // "III"
      engineFlags.push("fator-r indeciso (massa não informada) — assumido anexo III.");
    } else {
      anexo = efetivo.anexo;
    }
  } else {
    anexo = anexoInput ?? defaults.anexo;
  }

  // 6) Impostos por regime.
  const simples = impostoAnualSimples({ anexo, rbt12, receitaAnual: receita_bruta_ttm });
  const presumido = impostoAnualPresumido({
    trimestres: trimestresReceita, presuncaoIrpj, presuncaoCsll,
    receitasFinanceiras: receitas_financeiras_ttm, folhaCppAnual, encargoPct,
  });
  const real = impostoAnualReal({
    lucroAnual: resultado_antes_impostos_ttm, lucroTrimestres,
    receitaTributavel: receita_bruta_ttm * receitaTributavelPct, receitasFinanceiras: receitas_financeiras_ttm,
    creditoPct, folhaCppAnual, encargoPct,
  });

  // 7) Elegibilidade do Simples.
  const elegSimples = elegibilidadeSimples(rba);

  // 8) Comparação.
  const comparados = compararRegimes({ simples, elegSimples, presumido, real, receitaAnual: receita_bruta_ttm });

  // 8b) Degradação honesta: sinais de dados essenciais ausentes/defaulted.
  const folhaConhecida = folhaCppAnual != null;
  const ttmCompleto = meses >= 12;
  const dadosCompletos = folhaConhecida && ttmCompleto;
  const encargoInformado = encargoPctIn != null;
  const recTribInformado = recTribPctIn != null;
  // Sem folha, o CPP de Presumido/Real não é estimado (cai a 0 via `?? 0`), subestimando esses regimes.
  if (!folhaConhecida) {
    for (const c of comparados) {
      if (c.regime === "presumido" || c.regime === "real") {
        c.flags.push("CPP não estimado (folha não informada) — total federal+CPP subestimado.");
      }
    }
  }

  // 9) Recomendação.
  const rec = recomendarRegime(comparados, regime_atual, { bandaErro: 0.05, dadosCompletos });

  // 10) Confiança.
  const semFlagsFortes = folhaConhecida && recTribInformado && encargoInformado && elegSimples.status_elegibilidade === "elegivel";
  const conf = scoreConfiancaRegime({ recomendado: rec.recomendado, folhaConhecida, semFlagsFortes, ttmCompleto });
  // Sinais de inputs no default silencioso (viés pró-Presumido/Real).
  if (!encargoInformado) conf.motivos.push("Encargo patronal no default 20% (CPP estrita; RAT/FAP/terceiros fora) — pode subestimar Presumido/Real.");
  if (!recTribInformado) conf.motivos.push("Receita tributável PIS/COFINS assumida 100% (monofásico/ST/alíquota-zero não segregados).");
  // Anexa as flags de nível-engine aos motivos da confiança.
  conf.motivos.push(...engineFlags);

  return {
    empresa,
    regime_atual,
    ttm: { ano_mes_fim, meses },
    comparados,
    recomendado: rec.recomendado,
    economia_anual: rec.economia_anual,
    status: rec.status,
    break_even: {
      margem_real_vs_presumido: breakEvenMargemReal({ presuncaoIrpj, presuncaoCsll }),
      fator_r: 0.28,
    },
    eixo_indireto: {
      icms_iss_ipi_simples: simples.icms_iss_ipi,
      observacao: "ICMS/ISS/IPI comparados à parte; constantes entre Presumido e Real.",
    },
    confianca: conf,
    regime_inputs: {
      folha_cpp_anual: folhaCppAnual,
      massa_fator_r_anual: massaFatorRAnual,
      encargo_patronal_pct: encargoPctIn,
      presuncao_irpj: presuncaoIrpjIn,
      presuncao_csll: presuncaoCsllIn,
      credito_pis_cofins_estimado: creditoIn,
      receita_tributavel_pis_cofins_pct: recTribPctIn,
      anexo_simples: anexoInput,
    },
  };
}

const NIVEL_NUM: Record<"alta" | "media" | "baixa", number> = { baixa: 1, media: 2, alta: 3 };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeMaster(req);
  if (!auth.ok) return auth.response;

  const db: DbClient = createClient(SUPABASE_URL, SERVICE_ROLE);

  const por_empresa: RegimeEmpresaResult[] = [];
  for (const empresa of EMPRESAS) {
    const res = await calcularEmpresa(db, empresa);
    if (res) por_empresa.push(res);
  }

  // Consolidado.
  let imposto_atual_total = 0;
  let imposto_otimizado_total = 0;
  let confianca_pior = 3;
  for (const e of por_empresa) {
    const atualComp = e.comparados.find((c) => c.regime === e.regime_atual);
    const atualValor = atualComp ? atualComp.total_federal_cpp : 0;
    imposto_atual_total += atualValor;
    // Otimizado = total do regime recomendado, ou o atual se status 'manter'/'incompleto'.
    let otimizadoValor = atualValor;
    if (e.status !== "manter" && e.status !== "incompleto" && e.recomendado != null) {
      const recComp = e.comparados.find((c) => c.regime === e.recomendado);
      otimizadoValor = recComp ? recComp.total_federal_cpp : atualValor;
    }
    imposto_otimizado_total += otimizadoValor;
    const n = NIVEL_NUM[e.confianca.nivel];
    if (n < confianca_pior) confianca_pior = n;
  }
  const economia_total = Math.max(0, imposto_atual_total - imposto_otimizado_total);
  const confianca: "alta" | "media" | "baixa" = confianca_pior === 1 ? "baixa" : confianca_pior === 2 ? "media" : "alta";

  const result: RegimeTributarioResult = {
    por_empresa,
    consolidado: { imposto_atual_total, imposto_otimizado_total, economia_total, confianca },
    gerado_em: new Date().toISOString(),
  };
  return jsonResponse(result, 200);
});
