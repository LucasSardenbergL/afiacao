// Marcador de versão da edge `generate-bundle-argument`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTE ARQUIVO EXISTE — a irmã desta edge no #1520 (`generate-tactical-plan`) ganhou o
// marcador no #1754, porque a sonda dela era CEGA. Aqui o buraco era maior: não havia sonda
// nenhuma, nem canária. Zero caminhos de prova, e nenhum construível de fora — esta edge é chamada
// pelo BROWSER (`useBundleArguments`), então não deixa rastro em `net._http_response` nem linha em
// `cron.job_run_details`, que é como as edges de cron se deixam auditar.
//
// E é a das duas cujo dano já é ATIVO: o front do #1520 está publicado (provado nos bytes) e parou
// de mandar `margin` por SKU e `lieBundle`; o bundle anterior imprime `p.margin.toFixed(2)` e
// `bundle.lieBundle.toFixed(2)` incondicionalmente no prompt → `undefined.toFixed` → TypeError →
// catch externo → HTTP 500. O argumento de venda não gera. Ver `docs/agent/deploy.md` §"Merge na
// `main` ≠ produção" (o achado do #1752) para o quadro das três camadas.
//
// ⚠️ Diferente da irmã, aqui um bundle pré-sonda NÃO responde nada parecido com sonda: ele não
// conhece `probe`, cai no gate JWT desta edge e devolve 401 (a chamada do SQL Editor manda
// `x-cron-secret`, não `Authorization`). 401 aqui é veredito de "bundle velho", não de permissão —
// e custa zero, porque o 401 vem antes de qualquer token gasto.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("generate-bundle-argument");

/**
 * Marcador de versão servido pela edge. **Atualize a cada mudança relevante de comportamento** —
 * é ele que distingue um bundle novo de um velho em produção.
 *
 * `v1.0-prompt-sem-margem` = o contrato do #1520 nesta edge: o prompt da LLM não imprime mais
 * margem por SKU nem LIE do bundle, e o tipo do payload não pede `margin`/`lieBundle`. Nasce
 * nomeando essa fatia porque é a entrega cuja prova de deploy faltou — um bundle que responde este
 * marcador é necessariamente ≥ o #1520.
 *
 * ⚠️ O sensor só prova versões A PARTIR DE SI MESMO: ausência do campo `versao` na resposta é
 * bundle pré-marcador, não "versão errada".
 */
export const VERSAO = "v1.0-prompt-sem-margem";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama o modelo Anthropic (custo por token) e devolve o texto que a vendedora lê como argumento de venda";
