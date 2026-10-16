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

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
/**
 * v1.0 (2026-10-16) — varredura nova: cron 12:30 · 17:30 · 22:30 SP, emissão dos últimos 7 dias, sem cancelados;
 * situação importável em LISTA FECHADA (vazia na partida = só relata); bloqueia a rodada com pedido do app em
 * voo/conciliação; falha → e-mail 1 vez por protocolo. Revisão Codex: lista fechada revalidada na releitura da
 * importadora, página ilegível/HTTP ≥ 400 = falha (nunca lista parcial completa), rodada com falha = erro no registro,
 * timeout da importadora = indeterminado (sem e-mail).
 */
export const VERSAO = "v1.0-varredura-portal";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack para ler a lista de pedidos e, para pedido novo, " +
  "grava o pedido no app e cria pedido de compra REAL no Omie";
