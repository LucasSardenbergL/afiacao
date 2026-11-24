// Marcador de versão da edge `omie-pv-exclusao-reconciliar`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: LÊ o Omie (ListarPedidos por janela de inclusão e ConsultarPedido, ≤ 1/h por conta) e, com
// 2 ausências afirmadas do PV, DÁ BAIXA no app: deleted_at nas linhas do PV e libera a reserva de estoque com trilha.
// Nunca escreve no Omie. Por isso a sonda responde ANTES de tudo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-pv-exclusao-reconciliar");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * O CHANGELOG de cada versão vive em `docs/historico/versao-omie-pv-exclusao-reconciliar.md`.
 */
export const VERSAO = "v1.0-baixa-pv-excluido-no-omie";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge consulta o Omie (ListarPedidos e ConsultarPedido, só leitura) e DÁ BAIXA no app de PV excluído no Omie: " +
  "marca deleted_at nas linhas do pedido e LIBERA a reserva de estoque; não cria nem altera nada no Omie";
