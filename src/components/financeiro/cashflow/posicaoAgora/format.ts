// Helpers de formatação do PosicaoAgora.
// Extraídos verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).

export const fmt = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};
