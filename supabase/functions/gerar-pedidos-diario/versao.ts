// Marcador de versão da edge `gerar-pedidos-diario`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: regenera o ciclo de sugestões de compra e dispara e-mail (Resend) ao time.
// O e-mail é externo e não se desfaz; a regeneração mexe no ciclo que o comprador está olhando.
// Menos grave que submeter pedido ao fornecedor, mas ainda sem caminho de diagnóstico barato.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("gerar-pedidos-diario");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge regenera o ciclo de sugestões de compra e dispara e-mail ao time";
