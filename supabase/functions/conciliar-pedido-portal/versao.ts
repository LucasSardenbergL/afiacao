// Marcador de versão da edge `conciliar-pedido-portal`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: além de gravar a conciliação, ela CRIA O PO NO OMIE chamando
// `disparar-pedidos-aprovados` (guard anti-duplicado por `omie_pedido_compra_id`, §4.4). É a mesma
// classe de efeito da edge que ela chama — por isso a sonda precisa responder ANTES de tudo.

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge grava a conciliação e cria pedido de compra REAL no Omie";
