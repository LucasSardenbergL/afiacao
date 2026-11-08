// Marcador de versão da edge `sayerlack-encerrar-cancelado-portal`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: CONSULTA o Omie (ConsultarPedCompra, só leitura) e, com a prova de que o AFI-<id> não existe lá,
// ENCERRA no app (cancelado_humano + trilha) um pedido aceito no portal Sayerlack, sem PO, que o fornecedor cancelou.
// Nunca cria nem altera nada no Omie nem no portal. Por isso a sonda responde ANTES de tudo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sayerlack-encerrar-cancelado-portal");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * O CHANGELOG de cada versão vive em `docs/historico/versao-sayerlack-encerrar-cancelado-portal.md`.
 */
export const VERSAO = "v1.0-encerrar-cancelado-no-fornecedor";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge consulta o Omie e ENCERRA no app (cancelado_humano, com trilha de auditoria) um pedido aceito no portal " +
  "Sayerlack que o fornecedor cancelou; não cria nem altera nada no Omie nem no portal";
