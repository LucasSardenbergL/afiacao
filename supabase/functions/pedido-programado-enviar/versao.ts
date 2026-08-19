// Marcador de versão da edge `pedido-programado-enviar`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: cria `sales_orders` (pedidos de venda) a partir do programado, marca o envio
// como `enviado` e dispara `omie-vendas-sync`. O efeito é no BANCO, não num sistema de terceiro —
// mas é escrita de money-path que muda o que o comercial vê, e não há caminho barato sem a sonda.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("pedido-programado-enviar");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge cria sales_orders e marca envios programados como enviados";
