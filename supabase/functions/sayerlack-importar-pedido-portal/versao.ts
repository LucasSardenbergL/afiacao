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
/**
 * v1.1 (2026-10-16) — espera a tabela do portal inicializar (jQuery + DataTables) antes de filtrar e espera a RESPOSTA
 * da consulta (POST /order-viewer/form/list, 1 nova tentativa) em vez de desistir em 8 s de tabela vazia. 1º uso real
 * (2141068) voltava "0 linha(s) lida(s)" com o pedido existindo.
 */
/**
 * v1.2 (2026-10-16) — pedido com situação "6 - Cancelado" no portal é recusado na leitura (motivo `pedido_cancelado`),
 * nada é gravado nem vai ao Omie (palavra do founder).
 */
/**
 * v1.3 (2026-10-16) — aceita `situacoes_permitidas` (lista fechada de códigos, só a varredura manda): a situação RELIDA
 * tem de estar nela antes da RPC (pedido que faturou no meio da rodada não vira PO; Codex P1).
 */
export const VERSAO = "v1.3-situacao-permitida-na-releitura";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack para ler um pedido, grava o pedido no app " +
  "e cria pedido de compra REAL no Omie";
