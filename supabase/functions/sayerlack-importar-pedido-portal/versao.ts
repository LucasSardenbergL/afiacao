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
 * v1.4 (2026-11) — lê a condição de pagamento na tela de detalhe e passa à RPC (6 args); disparo com prazo; após gravar, nunca "não importado".
 */
/**
 * v1.5 (2026-11-07, pontos cegos Onda 2) — re-disparo de pedido já gravado RELÊ a situação no portal antes de pedir o
 * PO (cancelado/ilegível/fora da lista ⇒ não re-dispara); toda tentativa vai ao ledger `acoes_execucoes`
 * (`reposicao.importar_portal_sayerlack`); PO confirmado resolve na hora a pendência da varredura; CP006 diz o NCM e o
 * passo; devolve as opções de condição do portal (de-para D-2).
 */
/**
 * v1.6 (2026-11-08, pontos cegos Onda 5A fatia 1) — a situação lida do pedido (código 1..7, linha única da OBEN) vai
 * para o pedido pelo escritor único `sayerlack_registrar_situacao_portal`, inclusive quando a leitura recusa por
 * cancelado; a resposta diz `situacao_gravada`. Migration 20261108120000 ANTES.
 */
/**
 * v1.7 (2026-11-08, revisão 2) — situação sem código 1..7 recusa (B1); re-disparo de faturado 3/7 recusa (B2); situação
 * regravada 1× se falhar e no ledger (B3); #id nunca se perde (B7); 1ª importação grava a situação (B10); opções de
 * condição no ledger (B11). Migration 20261109120000 (B13) antes.
 */
/**
 * v1.8 (2026-11-08, revisão 2, 8.2) — funções de PÁGINA (filtros, tabela da consulta, condição) saem do template para
 * `_shared/sayerlack-portal-dom.ts`, testadas contra HTML real; comportamento igual.
 */
/**
 * v1.9 (2026-11-08, revisão 2, 7.2 + 4.3) — cada leitura do portal grava a EVIDÊNCIA imutável em
 * `sayerlack_portal_evidencia` (fail-open; `evidencia_id` no ledger) e toda resposta diz `sessao_browserless`.
 * Migration 20261111090000 antes.
 */
/**
 * v1.10 (2026-11-08, revisão 2, 7.1) — pedido existente sem PO com PO lançado à mão no Omie: em vez de só avisar,
 * chama a RPC `sayerlack_vincular_po_manual` (contrato por token, dono do PO, SKU/quantidade/valor), que vincula e
 * audita em `acoes_execucoes`; não casou ⇒ recusa com o motivo e as diferenças, sem re-disparo. Migration
 * 20261111110000 antes.
 */
/**
 * v1.11 (2026-11-09, revisão 2, 5.2 fatia 1) — antes de re-disparar pedido sem PO, confere o pedido do app com a
 * leitura (RPC `sayerlack_conferir_portal`: SKU/quantidade contra os itens, valor por item/total/condição contra o
 * retrato); divergiu ⇒ `alterado_no_portal` com as diferenças, sem disparo. Condição ilegível no re-disparo também
 * recusa. A RPC achando o pedido já gravado (outra aba) passa pelas mesmas recusas. Migration 20261111140000 antes.
 */
export const VERSAO = "v1.11-confere-portal";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack para ler um pedido, grava o pedido no app " +
  "e cria pedido de compra REAL no Omie";
