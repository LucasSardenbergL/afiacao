// src/lib/financeiro/regime-tributario-helpers.ts
// Otimizador Tributário — comparador de regime (Simples × Presumido × Real). Módulo puro,
// espelhado VERBATIM no engine Deno supabase/functions/fin-regime-tributario/index.ts.
//
// Tabelas de partilha (repartição) conferidas (2026-05) contra LC 123/2006 c/ LC 155/2016
// (Anexos I, II, III, V — Planalto + CDM Contabilidade). Cada faixa soma 1.0 (invariante testada).
import { ANEXOS_SIMPLES, type AnexoSimples } from './dre-tabelas-tributarias';
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
