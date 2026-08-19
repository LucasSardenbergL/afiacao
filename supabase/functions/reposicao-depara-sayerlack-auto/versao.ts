// Marcador de versão da edge `reposicao-depara-sayerlack-auto`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: grava de-para SKU nosso ↔ SKU do portal Sayerlack (RPC
// `reposicao_aplicar_depara_sayerlack_auto`, insert-only e auditável). O efeito não aparece aqui,
// e sim depois: de-para é o que torna um item VISÍVEL para o motor de reposição, e um mapeamento
// errado vira compra do item errado no fornecedor. Por isso o gate de gabarito — mas a sonda
// existe justamente para não depender de rodar o fluxo para saber qual bundle está no ar.
//
// ⚠️ O cabeçalho do index.ts promete que ela "NÃO toca parâmetro nem dispara compra" — confirmado
// no código (nenhum `.insert/.update/.delete` direto, uma única `.rpc`, e o gate de gabarito
// abortando ANTES de gravar quando o parser diverge dos de-paras manuais).
//
// Nota: esta edge não lia o corpo da requisição (o cron dispara sem body). O parse foi introduzido
// junto da sonda e é tolerante — body ausente/inválido continua sendo o caminho do cron.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("reposicao-depara-sayerlack-auto");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge grava de-para de SKU do fornecedor Sayerlack (RPC insert-only auditável); " +
  "mapeamento errado torna o item visível ao motor de reposição e vira compra do item errado";
