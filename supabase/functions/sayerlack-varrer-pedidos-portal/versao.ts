// Marcador de versão da edge `sayerlack-varrer-pedidos-portal`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: abre sessão autenticada no portal do FORNECEDOR (Sayerlack) via Browserless para LER a Consulta
// Pedidos da OBEN (só menu, filtros, "Filtrar" e paginação; nenhum clique de gravação) e, para cada pedido que não
// está no app nem no Omie, chama `sayerlack-importar-pedido-portal`, que grava o pedido e CRIA O PO NO OMIE.
// Por isso a sonda responde ANTES de tudo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sayerlack-varrer-pedidos-portal");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * O CHANGELOG de cada versão vive em `docs/historico/versao-sayerlack-varrer-pedidos-portal.md`.
 */
/**
 * v1.12 (2026-11-08, revisão 2, 7.1) — reconsulta de pedido do app sem PO com PO manual no Omie chama a RPC
 * `sayerlack_vincular_po_manual`: casou ⇒ vincula, audita e resolve a pendência (`po_manual_vinculado`); não casou ou
 * erro ⇒ a pendência fica com `vinculo_motivo`. Nunca re-dispara. Migration 20261111110000 antes.
 */
export const VERSAO = "v1.12-vincula-po-manual";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack para ler a lista de pedidos e, para pedido novo, " +
  "grava o pedido no app e cria pedido de compra REAL no Omie; pedido do app cancelado no portal e sem PO no Omie é " +
  "encerrado (cancelado_humano) com trilha de auditoria";
