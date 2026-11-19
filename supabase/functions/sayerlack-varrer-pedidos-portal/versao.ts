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
 * v1.13 (2026-11-17) — o "0 de 0" de OUTRA consulta não é prova: só vale a resposta do pedido que o NOSSO clique em
 * Filtrar gerou (a página do portal consulta por conta própria; 6 das 20 rodadas das 22:30 gravaram sucesso com 0
 * linhas). O script espera a página se aquietar antes de clicar e não lê tabela que outra consulta possa ter mexido;
 * pedido que levava outro filtro reprova; 0 linhas só com success=true, o nosso filtro no pedido e a consulta REPETIDA
 * respondendo 0 de novo. O que a página consultava vai ao registro, no sucesso e na falha. Sem migration.
 */
export const VERSAO = "v1.14-senha-do-vault";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack para ler a lista de pedidos e, para pedido novo, " +
  "grava o pedido no app e cria pedido de compra REAL no Omie; pedido do app cancelado no portal e sem PO no Omie é " +
  "encerrado (cancelado_humano) com trilha de auditoria";
