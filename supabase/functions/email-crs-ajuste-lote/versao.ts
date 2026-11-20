// Marcador de versão da edge `email-crs-ajuste-lote` (Fase 2a do lote mínimo Sayerlack).
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: ela ENVIA e-mail ao fornecedor (crs@sayerlack.com.br) pelo Gmail do founder —
// o pedido de redução da qtde lançada pelo lote mínimo e a cobrança no mesmo thread. Não há desfazer.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("email-crs-ajuste-lote");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-email-crs-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge envia e-mail ao fornecedor Sayerlack (crs@sayerlack.com.br) pelo Gmail do founder";
