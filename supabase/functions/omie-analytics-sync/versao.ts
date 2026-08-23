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
// (`doc_ambiguo_probe`) é NÃO-VERSIONADA — ela responde `probe_no_ar:true` igual num bundle de
// hoje e num de três fatias atrás, então não discrimina deploy integralmente velho
// (docs/agent/deploy.md, ⚠️ #2 "mente verde"). O marcador é o que fecha esse buraco.
//
// O gate desta edge é o `authorizeCronOrStaff` de `_shared/auth.ts`, que JÁ aceita
// `x-cron-secret`: a sonda entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-analytics-sync");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge sincroniza o Omie inteiro e, conforme a action, reescreve product_costs, order_items, " +
  "sales_orders, inventory_position e o mapa de identidade omie_customer_account_map — o custo que o " +
  "motor de recomendação lê para precificar e a posição de estoque que a reposição lê para comprar " +
  "passam a ter o número deste run; sync_customers enumera ~10k clientes do Omie em waitUntil, então " +
  "encerrar o request NÃO cancela a escrita que ele já disparou";
