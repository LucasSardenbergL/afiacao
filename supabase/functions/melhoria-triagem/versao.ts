// Marcador de versão da edge `melhoria-triagem`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26, 3ª leva do Lote C (plano de melhorias): edge ATIVA com escrita e sem prova de deploy.
// Contexto: chamada pelo browser (staff) para triar um item de melhoria com IA.
// O gate (`authorizeCronOrStaff`) aceita `x-cron-secret`; a sonda vem ANTES da exigência de staff.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATA — cron cai no 403 "Apenas staff" antes de qualquer I/O.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("melhoria-triagem");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.1-rpc-literal";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge paga a triagem por IA de um item de melhoria e REGRAVA o item e o histórico" +
  " (melhoria_itens/mensagens)";
