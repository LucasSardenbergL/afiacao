// Marcador de versão da edge `sayerlack-importar-pedido-portal`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: abre sessão autenticada no portal do FORNECEDOR (Sayerlack) via Browserless para LER
// um pedido que o founder digitou lá (consulta + itens; nenhum clique de gravação), grava o pedido no app
// (RPC `sayerlack_importar_pedido_portal`) e CRIA O PO NO OMIE chamando `disparar-pedidos-aprovados`.
// É a mesma classe de efeito da conciliação — por isso a sonda responde ANTES de tudo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sayerlack-importar-pedido-portal");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-importar-pedido-portal";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack para ler um pedido, grava o pedido no app " +
  "e cria pedido de compra REAL no Omie";
