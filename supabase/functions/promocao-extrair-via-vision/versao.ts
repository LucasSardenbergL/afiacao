// Marcador de versão da edge `promocao-extrair-via-vision`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Substitui a canária antiga (`body.probe === true` cru, que o SQL Editor — mandando a string
// "true" — fazia cair no fluxo real). O gate da edge é `authorizeCronOrStaff`, que aceita o
// `x-cron-secret` ⇒ sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("promocao-extrair-via-vision");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.1-reverte-bot-lovable";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge sobe o anexo para o storage, paga tokens da Anthropic para extraí-lo e GRAVA a " +
  "campanha ou o aumento de preço extraído (promocao_*), que alimenta o custo da reposição";
