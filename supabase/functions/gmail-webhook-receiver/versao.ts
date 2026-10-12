// Marcador de versão da edge `gmail-webhook-receiver`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26 (Lote C do plano de melhorias): edge com escrita e sem prova de deploy.
// O gate é o segredo do webhook no Bearer, que NÃO aceita `x-cron-secret`.
// A sonda entra com gate PRÓPRIO (`authorizeCronOrStaff`), e só para corpo de sonda — GATE_PROPRIO.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("gmail-webhook-receiver");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge registra o e-mail do fornecedor (gmail_webhook_log) e abre o ALERTA de compra " +
  "(fornecedor_alerta) que a reposição trata";
