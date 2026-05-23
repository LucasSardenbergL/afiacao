// src/lib/financeiro/dre-tabelas-tributarias.ts
// Tabelas legais (LC 123/2006 c/ LC 155/2016, vigente desde 2018). Conferir contra a
// Receita Federal ao manter. Valores verificados (2026-05) contra Contabilizei e ContaAgil.
// Espelhado verbatim no engine Deno.

export type AnexoSimples = 'I' | 'II' | 'III' | 'IV' | 'V';
export type FaixaSimples = { ate: number; aliquota: number; deduzir: number };

// `ate` = limite superior do RBT12 (R$); `aliquota` = alíquota nominal como fração;
// `deduzir` = parcela a deduzir (R$). Alíquota efetiva = (RBT12 * aliquota - deduzir) / RBT12.
export const ANEXOS_SIMPLES: Record<AnexoSimples, FaixaSimples[]> = {
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
export const PRESUMIDO = {
  irpj_aliquota: 0.15,
  irpj_adicional_aliquota: 0.10,
  irpj_adicional_limite_trimestral: 60000,
  csll_aliquota: 0.09,
  pis_aliquota: 0.0065,
  cofins_aliquota: 0.03,
};

// Limiar do Fator-R: ≥28% folha/receita → Anexo III; < 28% → Anexo V.
export const FATOR_R_LIMIAR = 0.28;
