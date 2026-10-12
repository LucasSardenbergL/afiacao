// Marcador de versão da edge `scoring-recalc-client`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26 (Lote C do plano de melhorias): edge com escrita e sem prova de deploy. O gate é
// `authorizeCronOrStaff`, que aceita o `x-cron-secret` do SQL Editor ⇒ sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("scoring-recalc-client");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge recalcula e GRAVA os scores do cliente (farmer_client_scores) e consome a fila " +
  "score_recalc_pending, que o farmer usa para priorizar a carteira";
