// Marcador de versão da edge `sayerlack-rotacionar-senha`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: ela TROCA a senha do usuário no portal do fornecedor (SSO TOTVS)
// e grava a nova no Vault — a senha antiga deixa de valer. A sonda responde sem tocar no portal.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sayerlack-rotacionar-senha");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.2-email-copia-colacor";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge troca a senha do usuario no portal Sayerlack (SSO TOTVS) e grava a nova no Vault; " +
  "a senha antiga deixa de valer para as 4 integracoes do portal";
