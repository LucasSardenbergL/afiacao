// Marcador de versão da edge `tint-omie-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26 (Lote C do plano de melhorias): edge com escrita e sem prova de deploy. O gate é
// `authorizeCronOrStaff`, que aceita o `x-cron-secret` do SQL Editor ⇒ sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("tint-omie-sync");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge pagina o catálogo de produtos no Omie e faz UPSERT em omie_products, a base de " +
  "preço e custo que o tintométrico e a reposição leem";
