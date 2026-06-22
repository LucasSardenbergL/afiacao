// Custo canônico para consumidores money-path (margem/scoring) no frontend.
//
// Espelha a regra do edge fin-valor-cockpit: canônico = cost_final (saída do motor de custo,
// SEMPRE presente — CMC real ou proxy honesto); fallback p/ cost_price (custo real legado)
// quando cost_final é ausente/inválido. ausente≠zero: 0/null/NaN/negativo NUNCA viram custo —
// retornam null para o chamador EXCLUIR o SKU do cálculo (em vez de fabricar margem 100%).
//
// Por que existe: hooks (bundle/cross-sell/farmer) faziam Number(cost_price), e com cost_price
// agora nullable (proxy não é mais semeado em cost_price), Number(null)===0 inflava a margem.

export function custoValido(x: number | string | null | undefined): number | null {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

export function custoCanonico(row: {
  cost_final?: number | string | null;
  cost_price?: number | string | null;
}): number | null {
  return custoValido(row.cost_final) ?? custoValido(row.cost_price);
}
