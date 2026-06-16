// Helpers de formatação e rótulos de impostos do Cockpit financeiro.
// Extraídos verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).

export const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};

export const IMPOSTO_LABEL: Record<string, string> = {
  ded_icms: 'ICMS', ded_iss: 'ISS', ded_pis: 'PIS', ded_cofins: 'COFINS', ded_ipi: 'IPI',
  das: 'DAS (Simples)', irpj: 'IRPJ', csll: 'CSLL',
};
