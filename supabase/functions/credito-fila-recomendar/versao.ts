// Marcador de versão da edge `credito-fila-recomendar` (crédito-IA PR 6a).
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: chama a API paga da Anthropic e grava a recomendação CONSULTIVA da fila de
// crédito (`credito_fila_recomendacao`). Não autoriza pedido nenhum.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("credito-fila-recomendar");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-fila-recomendacao";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama a API paga da Anthropic para recomendar itens da fila de crédito";
