// Marcador de versão da edge `carteira-positivacao-snapshot`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// É a edge com o pior custo de sondar às cegas deste recorte, e a razão está no default do corpo:
// com `mes` AUSENTE ela resolve o mês ANTERIOR em BRT e faz upsert em
// `carteira_positivacao_snapshot`. Um `{"probe":true}` num bundle PRÉ-sensor não é diagnóstico —
// é o snapshot do mês fechado sendo REGRAVADO, com o helper de paginação velho.
//
// E o que se grava é congelado: o próprio `_shared/mapas-paginados.ts` documenta que uma página
// perdida de `sales_orders` (~31 mil linhas) vira `had_order_in_month:false` e `revenue_month:0`
// para um cliente que comprou de verdade — "não consegui ler" carimbado como "não comprou", num
// mês que ninguém recalcula (money-path.md §2: ausente ≠ zero). Deploy primeiro, sonda depois.
//
// O gate desta edge já é `authorizeCronOrStaff`, que aceita `x-cron-secret`: a sonda entra logo
// APÓS ele, sem gate próprio. O parse do corpo subiu para ANTES do `createClient` — a sonda tem de
// decidir sem ter aberto conexão (gate estrutural "a sonda responde ANTES do createClient").

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("carteira-positivacao-snapshot");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "com `mes` ausente esta edge REGRAVA (upsert) o snapshot de positivação do mês ANTERIOR em " +
  "carteira_positivacao_snapshot, lendo sales_orders inteira (~31 mil linhas); o snapshot é " +
  "congelado, então uma página perdida grava had_order_in_month:false e revenue_month:0 para " +
  "quem comprou — num mês fechado que ninguém recalcula";
