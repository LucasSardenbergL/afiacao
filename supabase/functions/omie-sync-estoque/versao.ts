// Marcador de versão da edge `omie-sync-estoque`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela REESCREVE o saldo que o motor de reposição consome — upsert em
// `sku_estoque_atual` e `sku_status_omie`, linhas em `eventos_outlier`, e avanço do marcador de
// frescor em `sync_state` (`gravarMarcadorSentinela`). `sku_parametros` ela só LÊ.
//
// Por que a sonda importa aqui: o custo não é "gastar uma chamada", é que um run parcial do Omie
// vira saldo "atual" com cara de bom. O saldo alimenta sugestão de compra; e o marcador avançado
// diz ao Sentinela que o dado está fresco — ou seja, o run ruim também apaga o sinal de que
// ele foi ruim. Trocar em três palavras: aqui a falha é SILENCIOSA por desenho do frescor.
//
// O gate desta edge é `authorizeCronOrStaff` (`_shared/auth.ts`), que JÁ aceita `x-cron-secret`:
// a sonda entra logo APÓS ele, sem gate próprio — diferente das edges de NF-e (#1753/#1766).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync-estoque");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge REESCREVE o saldo de estoque que o motor de reposição consome (upsert em " +
  "sku_estoque_atual e sku_status_omie, eventos_outlier) e AVANÇA o marcador de frescor em " +
  "sync_state — um run parcial do Omie vira saldo 'atual' e ainda apaga o sinal de que foi parcial";
