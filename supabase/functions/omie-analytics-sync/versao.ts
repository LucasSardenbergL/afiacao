// Marcador de versão da edge `omie-analytics-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela é o sincronizador do Omie inteiro e reescreve, conforme a `action`,
// `product_costs`, `order_items`, `sales_orders`, `inventory_position` e o mapa de identidade
// (`omie_customer_account_map`) — o custo que o motor de recomendação lê para precificar e a
// posição de estoque que a reposição lê para comprar passam a ter o número deste run.
//
// Por que a sonda aqui, e por que ela é BARATA nesta edge (ao contrário da `fin-cashflow-engine`):
// a edge roteia por `action` e um corpo sem `action` conhecida já cai no `default` com 400 "Ação
// desconhecida", sem tocar o Omie nem o banco. Ou seja, sondar um bundle PRÉ-sensor aqui não
// dispara o efeito caro — ele responde 400. Isso torna a leitura da sonda inequívoca e sem risco:
//
//   {ok,probe:true,versao} → bundle COM sensor (este)
//   400 "Ação desconhecida" → bundle PRÉ-sensor, o deploy não subiu
//
// Essa é a diferença que justifica instrumentar: a canária que a edge já tinha
// (`doc_ambiguo_probe`) respondia `probe_no_ar:true` igual num bundle de hoje e num de três fatias
// atrás, então não discriminava deploy integralmente velho (docs/agent/deploy.md, ⚠️ #2 "mente
// verde"). O marcador é o que fecha esse buraco.
//
// ⚠️ CORREÇÃO (auditoria dos contratos de canária, 2026-08-25): este comentário dizia que a
// `doc_ambiguo_probe` é "NÃO-VERSIONADA", e isso deixou de ser verdade em 2026-08-23 — o
// d8cf07152 versionou as 3 canárias que faltavam, e ela emite `contrato:
// "doc-ambiguo-fail-closed-v1"` desde então. A conclusão sobrevive, mas por outra razão, e a
// diferença importa: a canária não é cega por FALTA de marcador, é cega porque o marcador dela
// está parado em d8cf07152 enquanto a edge andou três fatias (#1991, 883080edb, #1992). Ou seja,
// a canária discrimina até a fatia do CONTRATO dela e não além — que é exatamente a mesma classe
// que este arquivo documenta, só que na canária. Sonda e canária carregam marcadores
// INDEPENDENTES: cada um prova "≥ a fatia que o definiu", e nenhum cobre o outro.
//
// O gate desta edge é o `authorizeCronOrStaff` de `_shared/auth.ts`, que JÁ aceita
// `x-cron-secret`: a sonda entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-analytics-sync");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * `v1.1-mapa-codigo-sem-alias` (#1971): `fetchCodigoUserMap` deixou de unir
 * `customer_canonical_alias` ao espelho — a fonte alias saiu, e o mapa passou a resolver só por
 * `omie_customer_account_map`. O #1971 mudou a edge e NÃO bumpou este marcador, então por um
 * intervalo a sonda respondia idêntico no bundle #1905 e no #1971: ela provava "≥ #1905" e nada
 * mais. Este bump reata a discriminação para o PRÓXIMO deploy — ele não recupera a do #1971, que
 * está perdida (ver `docs/historico/sonda-marcador-congelado.md`).
 *
 * `v1.2-produtos-teto-500-e-partial-honesto` (#1992, c63820508): TERCEIRA vez que esta mesma edge
 * congela o marcador, e a primeira achada por uma régua e não por leitura. O #1992 trocou o teto
 * de páginas de `products` (10 → `MAX_PAGINAS_PRODUTOS = 500`), consolidou o `updateSyncState` que
 * gravava `status:"complete"` INCONDICIONALMENTE no que grava `complete ? "complete" : "partial"`,
 * e tirou o `syncProducts` do caminho de full sync. Três mudanças observáveis em produção, e o
 * marcador não se moveu.
 *
 * ⚠️ Por que passou: o gate que pega esta classe (`scripts/sonda-versao-bump-gate.ts`, #1993)
 * mergeou DEPOIS do #1992 — `git merge-base --is-ancestor d79fb41d7 c63820508` responde não. O
 * gate é de TRANSIÇÃO e não descobre omissão ANTIGA, exatamente como o próprio doc dele declara.
 * Quem achou foi rodá-lo para trás: `--base c63820508^ --head c63820508` reprova com exit 1.
 *
 * ⚠️ E aqui o congelamento já cobrou o preço, não hipoteticamente: ao auditar, tentei responder
 * "o #1992 já está no ar?" e não consegui. O dado de prod é ambíguo (`sync_state` de
 * products/colacor_vendas: `complete`, 4297, last_page 43 — mas o bundle VELHO também gravava
 * `last_page` com o total DECLARADO pelo Omie, então 43 > 10 não prova travessia), e a sonda
 * responde a MESMA string nos dois casos. O bump é o que devolve essa resposta.
 */
export const VERSAO = "v1.4-apriori-snapshot-rpc";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge sincroniza o Omie inteiro e, conforme a action, reescreve product_costs, order_items, " +
  "sales_orders, inventory_position e o mapa de identidade omie_customer_account_map — o custo que o " +
  "motor de recomendação lê para precificar e a posição de estoque que a reposição lê para comprar " +
  "passam a ter o número deste run; sync_customers enumera ~10k clientes do Omie em waitUntil, então " +
  "encerrar o request NÃO cancela a escrita que ele já disparou";
