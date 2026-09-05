// Marcador de versão da edge `enviar-pedido-portal-sayerlack`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: ela SUBMETE o pedido no portal do fornecedor via Browserless —
// o fornecedor recebe de verdade, e não há desfazer. Depois disso ainda chama
// `disparar-pedidos-aprovados` para registrar o PO no Omie. Não existe caminho de diagnóstico
// barato sem a sonda.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("enviar-pedido-portal-sayerlack");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 * O CHANGELOG de cada versão vive em `docs/historico/versao-enviar-pedido-portal-sayerlack.md`
 * (aqui ele afundava o arquivo: cada bump só acrescenta comentário, e o gate `limpeza-fonte`
 * acusou 6 linhas de código em 66). Resumo: v1.1 pós-login por sinais do DOM · v1.2 fator de
 * embalagem · v1.3 fator aprovado ≠ vivo · v1.4 captura de custo deixou de ser cega ·
 * v1.5 escrita do custo em RPC transacional com CAS · v1.6 Preço Venda é o total da linha ·
 * v1.7 enviado = aprovado na quantidade (NULL lê-se 1:1; qtde fora do múltiplo recusa; normalização sai).
 */
export const VERSAO = "v1.7-enviado-igual-aprovado";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge SUBMETE o pedido no portal do fornecedor (Browserless) — o fornecedor recebe de verdade";
