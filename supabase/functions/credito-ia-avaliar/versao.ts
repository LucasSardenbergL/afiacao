// Marcador de versão da edge `credito-ia-avaliar` (crédito-IA PR 4).
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida. */
export const respostaSonda = criarRespostaSonda("credito-ia-avaliar");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-ficha-claude-travas-writer-unico";

/** O que um disparo (não-sonda) faz — citado no erro de sonda ambígua. */
export const EFEITO =
  "esta edge reivindica até 12 grupos da carteira, paga tokens da Anthropic por grupo e grava " +
  "propostas de limite de crédito (expirando a pendente anterior do grupo)";
