// src/lib/financeiro/regime-tributario-helpers.ts
// Otimizador Tributário — comparador de regime (Simples × Presumido × Real). Módulo puro,
// espelhado VERBATIM no engine Deno supabase/functions/fin-regime-tributario/index.ts.
//
// Tabelas de partilha (repartição) conferidas (2026-05) contra LC 123/2006 c/ LC 155/2016
// (Anexos I, II, III, V — Planalto + CDM Contabilidade). Cada faixa soma 1.0 (invariante testada).
import { ANEXOS_SIMPLES, type AnexoSimples, PRESUMIDO, FATOR_R_LIMIAR } from './dre-tabelas-tributarias';
import { aliquotaEfetivaSimples } from './dre-helpers';

export type PartilhaFaixa = { irpj: number; csll: number; cofins: number; pis: number; cpp: number; icms: number; iss: number; ipi: number };
export const PARTILHA_SIMPLES: Record<'I' | 'II' | 'III' | 'V', PartilhaFaixa[]> = {
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

export function partilhaIndiretoFrac(anexo: 'I' | 'II' | 'III' | 'V', rbt12: number, efetiva: number): number {
  const p = PARTILHA_SIMPLES[anexo][indiceFaixa(anexo, rbt12)];
  let iss_frac = efetiva * p.iss;
  if (iss_frac > TETO_ISS) iss_frac = TETO_ISS;
  return efetiva * (p.icms + p.ipi) + iss_frac;
}

export type ImpostoSimples = { total_federal_cpp: number; das_total: number; icms_iss_ipi: number; aproximado: boolean };
export function impostoAnualSimples(input: { anexo: 'I' | 'II' | 'III' | 'V'; rbt12: number; receitaAnual: number }): ImpostoSimples {
  const efetiva = aliquotaEfetivaSimples(input.anexo, input.rbt12);
  const das_total = efetiva * input.receitaAnual;
  const indireto_frac = partilhaIndiretoFrac(input.anexo, input.rbt12, efetiva);
  const icms_iss_ipi = indireto_frac * input.receitaAnual;
  return { total_federal_cpp: das_total - icms_iss_ipi, das_total, icms_iss_ipi, aproximado: true };
}

export type Elegibilidade = { status_elegibilidade: 'elegivel' | 'sublimite_excedido' | 'inelegivel'; motivo_inelegivel: string | null };
export function elegibilidadeSimples(rba: number): Elegibilidade {
  if (rba > TETO_RBA) return { status_elegibilidade: 'inelegivel', motivo_inelegivel: `RBA R$ ${(rba / 1e6).toFixed(2)}M > teto R$ 4,8M do Simples.` };
  if (rba > SUBLIMITE_RBA) return { status_elegibilidade: 'sublimite_excedido', motivo_inelegivel: null };
  return { status_elegibilidade: 'elegivel', motivo_inelegivel: null };
}

const IRPJ_ADIC_LIMITE_TRIM = PRESUMIDO.irpj_adicional_limite_trimestral; // 60000
const ADIC = PRESUMIDO.irpj_adicional_aliquota; // 0.10
const IRPJ = PRESUMIDO.irpj_aliquota;           // 0.15
const CSLL = PRESUMIDO.csll_aliquota;           // 0.09
const PIS_COFINS_NAO_CUMULATIVO = 0.0925;       // 1,65% + 7,6%
const PIS_COFINS_FINANCEIRO = 0.0465;           // 0,65% + 4% (Decreto 8.426/2015) — só no não-cumulativo

export function encargoPatronal(folhaCppAnual: number | null, pct: number): number | null {
  if (folhaCppAnual == null) return null;
  return folhaCppAnual * pct;
}

export type ImpostoPresumido = { irpj: number; csll: number; pis: number; cofins: number; cpp: number; total_federal_cpp: number };
export function impostoAnualPresumido(input: {
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

export type ImpostoReal = { irpj: number; csll: number; pis_cofins: number; cpp: number; total_federal_cpp: number; credito_aplicado: number; lucro_usado: number };
export function impostoAnualReal(input: {
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

export function anexoEfetivoFatorR(massaFatorR: number | null, receita: number): { anexo: 'III' | 'V'; fator_r: number | null; banda: boolean } {
  if (massaFatorR == null || receita <= 0) return { anexo: 'V', fator_r: null, banda: true };
  const fr = massaFatorR / receita;
  return { anexo: fr >= FATOR_R_LIMIAR ? 'III' : 'V', fator_r: fr, banda: false };
}

// Margem líquida (lucro/receita) abaixo da qual o IRPJ/CSLL do Real fica menor que o do Presumido (direcional).
export function breakEvenMargemReal(input: { presuncaoIrpj: number; presuncaoCsll: number }): number {
  return (input.presuncaoIrpj * IRPJ + input.presuncaoCsll * CSLL) / (IRPJ + CSLL);
}

export type RegimeNome = 'simples' | 'presumido' | 'real';
export type StatusElegibilidade = 'elegivel' | 'sublimite_excedido' | 'inelegivel';
export type StatusRecomendacao = 'recomenda' | 'empate_tecnico' | 'manter' | 'incompleto';
export type RegimeComparado = {
  regime: RegimeNome; elegivel: boolean; status_elegibilidade: StatusElegibilidade; motivo_inelegivel: string | null;
  total_federal_cpp: number; aliquota_efetiva: number | null; detalhe: Record<string, number>; aproximado: boolean; flags: string[];
};

export function compararRegimes(input: {
  simples: ImpostoSimples; elegSimples: Elegibilidade;
  presumido: ImpostoPresumido; real: ImpostoReal; receitaAnual?: number;
}): RegimeComparado[] {
  const rec = input.receitaAnual && input.receitaAnual > 0 ? input.receitaAnual : null;
  const simplesElegivel = input.elegSimples.status_elegibilidade !== 'inelegivel';
  const lista: RegimeComparado[] = [
    {
      regime: 'simples', elegivel: simplesElegivel, status_elegibilidade: input.elegSimples.status_elegibilidade,
      motivo_inelegivel: input.elegSimples.motivo_inelegivel, total_federal_cpp: input.simples.total_federal_cpp,
      aliquota_efetiva: rec ? input.simples.total_federal_cpp / rec : null,
      detalhe: { das_total: input.simples.das_total, federal_cpp_do_das: input.simples.total_federal_cpp, icms_iss_ipi: input.simples.icms_iss_ipi },
      aproximado: input.simples.aproximado, flags: input.elegSimples.status_elegibilidade === 'sublimite_excedido' ? ['Sublimite excedido — ICMS/ISS fora do DAS.'] : [],
    },
    {
      regime: 'presumido', elegivel: true, status_elegibilidade: 'elegivel', motivo_inelegivel: null,
      total_federal_cpp: input.presumido.total_federal_cpp, aliquota_efetiva: rec ? input.presumido.total_federal_cpp / rec : null,
      detalhe: { irpj: input.presumido.irpj, csll: input.presumido.csll, pis: input.presumido.pis, cofins: input.presumido.cofins, cpp: input.presumido.cpp }, aproximado: false, flags: [],
    },
    {
      regime: 'real', elegivel: true, status_elegibilidade: 'elegivel', motivo_inelegivel: null,
      total_federal_cpp: input.real.total_federal_cpp, aliquota_efetiva: rec ? input.real.total_federal_cpp / rec : null,
      detalhe: { irpj: input.real.irpj, csll: input.real.csll, pis_cofins: input.real.pis_cofins, cpp: input.real.cpp, credito_aplicado: input.real.credito_aplicado },
      aproximado: true, flags: ['Lucro real ≈ resultado contábil (sem LALUR).', input.real.credito_aplicado === 0 ? 'Crédito PIS/COFINS = 0 (faltam NCM/CFOP) — Real pode ser melhor.' : ''].filter(Boolean),
    },
  ];
  return lista.sort((a, b) => {
    if (a.elegivel !== b.elegivel) return a.elegivel ? -1 : 1;
    return a.total_federal_cpp - b.total_federal_cpp;
  });
}

export function recomendarRegime(comparados: RegimeComparado[], regimeAtual: RegimeNome, opts: { bandaErro: number; dadosCompletos?: boolean }):
  { recomendado: RegimeNome | null; economia_anual: number | null; status: StatusRecomendacao } {
  const elegiveis = comparados.filter((c) => c.elegivel);
  if (elegiveis.length === 0) return { recomendado: null, economia_anual: null, status: 'incompleto' };
  const melhor = elegiveis[0];
  if (opts.dadosCompletos === false) {
    return { recomendado: melhor.regime, economia_anual: null, status: 'incompleto' };
  }
  const atual = comparados.find((c) => c.regime === regimeAtual);
  const economia = atual ? atual.total_federal_cpp - melhor.total_federal_cpp : null;
  if (melhor.regime === regimeAtual) return { recomendado: regimeAtual, economia_anual: 0, status: 'manter' };
  const segundo = elegiveis[1];
  const dentroBanda = segundo ? (segundo.total_federal_cpp - melhor.total_federal_cpp) / Math.max(1, segundo.total_federal_cpp) < opts.bandaErro : false;
  const status: StatusRecomendacao = (melhor.regime === 'real' && dentroBanda) ? 'empate_tecnico' : 'recomenda';
  return { recomendado: melhor.regime, economia_anual: economia != null ? Math.max(0, economia) : null, status };
}

export function scoreConfiancaRegime(input: { recomendado: RegimeNome | null; folhaConhecida: boolean; semFlagsFortes: boolean; ttmCompleto?: boolean }):
  { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] } {
  const motivos: string[] = [];
  let nivel = 3;
  const baixar = (p: number, m: string) => { if (p < nivel) nivel = p; motivos.push(m); };
  if (input.ttmCompleto === false) baixar(1, 'TTM incompleto (<12 meses) — base anual não confiável.');
  if (input.recomendado === 'real') baixar(2, 'Lucro Real é triagem (sem LALUR/adições/exclusões) — confiança limitada.');
  if (!input.folhaConhecida) baixar(2, 'Folha (CPP) não informada — comparação Simples × outros incompleta.');
  if (!input.semFlagsFortes) baixar(2, 'Há flags de degradação (monofásico/ST/crédito não estimado).');
  return { nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa', motivos };
}
