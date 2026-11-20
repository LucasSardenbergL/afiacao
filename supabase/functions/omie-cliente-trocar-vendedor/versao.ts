// Marcador de versão da edge `omie-cliente-trocar-vendedor`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ESCREVE no Omie (AlterarCliente) o vendedor do cadastro do cliente — só
// `recomendacoes.codigo_vendedor`, em lote, para os códigos de origem/alvo fixos em `decisao.ts` — e grava o recibo em
// `omie_cliente_vendedor_troca` e o vendedor novo no espelho `omie_customer_account_map`. Por isso a sonda responde
// ANTES de tudo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-cliente-trocar-vendedor");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * O CHANGELOG de cada versão vive em `docs/historico/versao-omie-cliente-trocar-vendedor.md`.
 */
export const VERSAO = "v1.0-troca-vendedor-cadastro";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge ALTERA no Omie o vendedor do cadastro de clientes (AlterarCliente, em lote) e grava o recibo e o " +
  "espelho da carteira no banco";
