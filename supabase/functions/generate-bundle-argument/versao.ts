// Marcador de versão da edge `generate-bundle-argument`.
//
// O classificador da sonda (money-path, idêntico em toda edge) mora em `_shared/sonda-versao.ts` —
// um dono, um conjunto de testes. Aqui fica só o que é DESTA edge: a versão e a descrição do
// efeito que a recusa fail-closed cita.
//
// POR QUE A SONDA EXISTE AQUI (2026-08-14, auditoria do #1520): esta edge não tem canária nenhuma,
// e o #1520 mudou o CONTRATO de entrada dela — o front parou de mandar `margin` por produto e
// `lieBundle`, porque a versão antiga imprimia os dois em R$ dentro do prompt da LLM e o texto
// gerado é lido pela vendedora. O bundle ANTERIOR faz `p.margin.toFixed(2)` e
// `bundle.lieBundle.toFixed(2)` incondicionalmente: com o payload novo isso é TypeError, capturado
// pelo catch externo e devolvido como HTTP 500 — o argumento de venda simplesmente não sai. O
// frontend do #1520 está publicado desde então (provado nos bytes), e não havia como perguntar a
// produção QUAL bundle da edge está no ar: o front chama pelo browser, então não há rastro em
// `net._http_response` nem linha em `cron.job_run_details`.
//
// ⚠️ Bundle pré-sonda NÃO responde a sonda: ele não conhece `probe`, entra no gate JWT desta edge
// e devolve 401 (a chamada do SQL Editor manda `x-cron-secret`, não `Authorization`). 401 aqui é
// veredito de "bundle velho", não de permissão — e custa zero, porque o 401 vem antes da Anthropic.

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

/**
 * Marcador de versão servido pela edge. **Atualize a cada mudança relevante de comportamento** —
 * é ele que distingue um bundle novo de um velho em produção.
 *
 * `v1.0-prompt-sem-margem` = o prompt da LLM não imprime mais margem por SKU nem LIE do bundle, e
 * o tipo do payload não pede `margin`/`lieBundle`. Ver #1520 / 9f7e8962.
 *
 * ⚠️ O sensor só prova versões a partir de si mesmo: ausência do campo `versao` na resposta = bundle
 * pré-sensor, não "versão errada".
 */
export const VERSAO = "v1.0-prompt-sem-margem";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama a LLM da Anthropic (custo por token) e devolve o texto que a vendedora lê como argumento de venda";
