// O universo de PEDIDOS do scoring do farmer — DENYLIST, espelhando a autoridade da margem.
//
// POR QUE EXISTE: o hook filtrava por ALLOWLIST `('confirmado','faturado','entregue')` enquanto
// `private.margem_cliente_agregada()` filtra por DENYLIST. E `confirmado`/`entregue` têm ZERO
// linhas em prod, então a allowlist resolvia para só `faturado` e escondia 10.236 pedidos reais
// (`importado` 5.419 · `separacao` 2.809 · `enviado` 2.008) — R$ 6.985.425,66, 26% do faturamento.
// Consequência medida: a margem vinha de um universo e o resto do score de outro.
//
// ⚠️ NULL: tanto este filtro quanto o SQL da autoridade descartam `status IS NULL` — em SQL,
// `NULL NOT IN (...)` é NULL (não passa), e no PostgREST o `not.in` é NULL-blind do mesmo jeito.
// A paridade é intencional: espelhar a autoridade inclui espelhar como ela trata o nulo. Medido
// em prod (2026-08-13): 0 linhas com status nulo, então hoje o ponto é teórico.
//
// ⚠️ `deleted_at IS NULL` anda JUNTO. A allowlist antiga mascarava o problema; a denylist sozinha
// traria pedido apagado (hoje 0 linhas, mas o helper filtra e a paridade exige que este também
// filtre).

/** Status que NÃO são venda. Verbatim do corpo em prod de `private.margem_cliente_agregada()`. */
export const STATUS_NAO_VENDA: readonly string[] = [
  'cancelado',
  'rascunho',
  'pendente',
  'orcamento',
];

/** Valor pronto para o `.not('status', 'in', …)` do PostgREST: `("a","b",…)`. */
export const STATUS_NAO_VENDA_POSTGREST = `("${STATUS_NAO_VENDA.join('","')}")`;
