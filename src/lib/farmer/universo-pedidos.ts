// O universo de PEDIDOS dos motores do farmer — DENYLIST, espelhando a autoridade da margem.
//
// MORA EM `plataforma` (`src/lib/farmer/**`) porque os consumidores estão em DOIS módulos:
// `useFarmerScoring`/`useBundleEngine` (farmer-inteligencia) e `useCrossSellEngine` (vendas).
// Nasceu em `src/lib/scoring/` servindo só o primeiro; ficar lá faria o cross-sell importar de
// outro módulo de negócio — vazamento de fronteira, não detalhe de arrumação.
//
// POR QUE EXISTE: os hooks filtravam por ALLOWLIST `('confirmado','faturado','entregue')` enquanto
// `private.margem_cliente_agregada()` filtra por DENYLIST. E `confirmado`/`entregue` têm ZERO
// linhas em prod, então a allowlist resolvia para só `faturado` e escondia 10.281 pedidos reais
// (`importado` 5.455 · `separacao` 2.817 · `enviado` 2.009). Consequência medida no scoring: a
// margem vinha de um universo e o resto do score de outro.
//
// ⚠️ Os dois status mortos NUNCA existiram nesta tabela — não são vocabulário aposentado:
// `sales_orders` é 100% importada do Omie (2020→2026) e o único escritor (`omieEtapaToStatus`,
// `supabase/functions/_shared/omie-pedido.ts`) emite `importado|separacao|enviado|faturado|
// cancelado`. `entregue` é o vocabulário da tabela `orders` (kanban da afiação). Os três hooks
// nasceram no MESMO dia (2026-02-23, três commits "Changes") já com a allowlist, ANTES de o mapa
// etapa→status entrar no repo (2026-03-02): ela nunca casou com o dado que veio depois.
//
// ⚠️ NULL: tanto este filtro quanto o SQL da autoridade descartam `status IS NULL` — em SQL,
// `NULL NOT IN (...)` é NULL (não passa), e no PostgREST o `not.in` é NULL-blind do mesmo jeito.
// A paridade é intencional: espelhar a autoridade inclui espelhar como ela trata o nulo. Medido
// em prod (2026-08-20): 0 linhas com status nulo, então hoje o ponto é teórico.
//
// ⚠️ `deleted_at IS NULL` anda JUNTO. A allowlist antiga mascarava o problema; a denylist sozinha
// traria pedido apagado (hoje 0 linhas, mas o helper filtra e a paridade exige que este também
// filtre).
//
// ⚠️ SUPPORT É RAZÃO — ampliar o universo mexe no DENOMINADOR do Apriori (`useBundleEngine`), e
// isso troca regra sem que nenhuma cesta seja perdida. Medido em prod (2026-08-20): o par
// CATALISADOR FC.6975LT ↔ FUNDO PU FL.6673.00LT GANHA cestas (151→197) e ainda assim CAI do piso
// de 1% (1,0305% → 0,9129%), enquanto o par com o FUNDO PU FL.6298.00LT SOBE (134→225 cestas,
// 0,9145% → 1,0427%) e entra com lift maior (24,93 contra 16,37). Quem mexer no universo daqui
// para a frente mede as duas pontas — as 4 regras que o motor descobre vivem TODAS entre 1,03% e
// 1,22% de support, coladas no piso.

/** Status que NÃO são venda. Verbatim do corpo em prod de `private.margem_cliente_agregada()`. */
export const STATUS_NAO_VENDA: readonly string[] = [
  'cancelado',
  'rascunho',
  'pendente',
  'orcamento',
];

/** Valor pronto para o `.not('status', 'in', …)` do PostgREST: `("a","b",…)`. */
export const STATUS_NAO_VENDA_POSTGREST = `("${STATUS_NAO_VENDA.join('","')}")`;
