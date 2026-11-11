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
/** v1.1–v1.11 (2026-10-16 a 11-09): histórico em docs/historico/importar-pedido-portal-sayerlack.md e `git log -p` deste arquivo. */
/** v1.12 (2026-11-11, C16): retrato da tela sem condição na evidência + causa na recusa — docs/historico/sayerlack-condicao-ilegivel-c16.md */
/** v1.13 (2026-11-11) — detalhe aberto pelo CLIQUE no link do nº (o goto direto não chegava; condição ilegível). */
/** v1.14 (2026-11-11) — lê TODAS as opções de condição do portal (163; o teto 80 cortava o inventário do de-para). */
export const VERSAO = "v1.14-condicoes-opcoes-completas";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack para ler um pedido, grava o pedido no app " +
  "e cria pedido de compra REAL no Omie";
