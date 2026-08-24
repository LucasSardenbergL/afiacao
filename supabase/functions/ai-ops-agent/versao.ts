// Marcador de versão da edge `ai-ops-agent`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Oitava leva (#1889/#1901, paginação): uma das 7 edges dependentes do `_shared/paginate.ts` que
// não tinham sensor nenhum — deploy INVERIFICÁVEL, e o #1889 é no-op por DESENHO, então nenhuma
// canária de comportamento pode discriminar (`docs/historico/deploy-no-op-por-desenho.md`).
//
// CUSTO DO BUNDLE VELHO IGNORANDO `probe`: INÓCUO, e por acidente feliz do gate dela. O gate é JWT
// de usuário staff (`Authorization: Bearer` + `user_roles` em `employee`/`master`) e é a PRIMEIRA
// coisa do handler; o `net.http_post` do SQL Editor manda `x-cron-secret` e nenhum `Authorization`,
// então o bundle pré-sensor morre em `401 {"error":"Unauthorized"}` antes de tocar banco ou modelo.
// Veredito binário, sem efeito colateral:
//     {ok,probe:true,versao,edge}      → bundle COM sensor
//     401 {"error":"Unauthorized"}     → bundle PRÉ-sensor, o deploy não subiu
//
// Esse mesmo gate é o motivo de a sonda precisar de gate PRÓPRIO (`authorizeCronOrStaff`, lista
// GATE_PROPRIO do gate de contrato): o caminho documentado de invocação — SQL Editor via
// `net.http_post` com cron-secret — nunca chega ao gate normal. Seguir o gate da edge tornaria a
// sonda inalcançável justamente para quem precisa dela; responder sem gate a deixaria anônima.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("ai-ops-agent");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge APAGA todas as ai_decisions com status pending e as regrava do zero (delete + insert " +
  "em lote), depois de dar refresh na materialized view de métricas de cliente; um run não pedido " +
  "descarta decisão pendente que ninguém revisou — e o que sumiu não volta, porque a lista nova é " +
  "derivada das métricas do instante em que o run correu";
