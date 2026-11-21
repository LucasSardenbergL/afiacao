// Valor documental de título do Omie — AUSENTE ≠ ZERO (money-path.md §2).
// Antes: `t.valor_documento || t.nValorTitulo || 0` gravava R$ 0 quando o Omie omitia o valor →
// saldo 0 → o título vencido sumia da trava de crédito (P1 Codex 2026-11-20, spec crédito-IA §9.5).
// Hoje há 0 títulos assim em prod (psql-ro 2026-11-20): o furo é latente, a guarda é na origem.

// Só número ou string DECIMAL aceitos: `Number(false)`, `Number([])` e `Number("")` dão 0 (P1 review
// Codex 2026-11-20 — `false`/`[]` com nValorTitulo: 500 viravam R$ 0).
const DECIMAL = /^\s*\d+(\.\d+)?\s*$/;

function numeroOuNull(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && DECIMAL.test(v)) n = Number(v);
  else return null;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Número finito ≥ 0, ou `null` quando o Omie não informou um valor legível. `0` explícito é `0`. */
export function valorDocumentoTitulo(t: { valor_documento?: unknown; nValorTitulo?: unknown }): number | null {
  return numeroOuNull(t.valor_documento) ?? numeroOuNull(t.nValorTitulo);
}
