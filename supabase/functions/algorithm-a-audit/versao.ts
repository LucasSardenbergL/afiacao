// Marcador de versão da edge `algorithm-a-audit`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Escreve no NOSSO banco (`margin_audit_log`), então cai na regra da terceira leva (#1767) e não
// na exceção da leitura pura.
//
// O custo de sondar um bundle PRÉ-sensor é ESCRITA, não só tempo: sem a sonda, `{"probe":true}` é
// ignorado, a auditoria de margem roda inteira (order_items ~67 mil linhas, sales_orders ~31 mil,
// product_costs) e o resultado é INSERIDO em `margin_audit_log`. Por isso a ordem do ritual não é
// negociável aqui — deploy primeiro, sonda depois (`docs/agent/deploy.md` §Canárias): sondar antes
// grava uma auditoria que ninguém pediu, com o bundle velho.
//
// O gate desta edge já é `authorizeCronOrStaff`, que aceita `x-cron-secret`: a sonda entra logo
// APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("algorithm-a-audit");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reaudita a margem varrendo order_items (~67 mil linhas), sales_orders e " +
  "product_costs e GRAVA o resultado em margin_audit_log — uma auditoria que ninguém pediu entra " +
  "na série de margem que a gestão lê, com a data de hoje";
