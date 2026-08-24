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

/**
 * BUMP #1889/#1901 (paginação). O marcador anterior era `v1.0-sensor-inicial` — a MESMA string que já
 * respondia em produção. Marcador igual dos dois lados responde idêntico tendo o deploy acontecido
 * ou não, e o #1889 é no-op por DESENHO (enquanto o `max-rows` de prod for 1000, bundle novo e
 * velho devolvem os mesmos bytes), então NENHUMA canária de comportamento consegue discriminar
 * este deploy. O bump é PRÉ-REQUISITO da viagem, não consequência dela.
 * → `docs/historico/deploy-no-op-por-desenho.md`
 *
 * `v1.1-paginacao-eof-e-cursor` nomeia os dois fixes que esta fatia carrega até a edge: EOF por
 * página VAZIA (não mais página curta, #1889) e cursor comparado à PRIMEIRA linha da página
 * (#1901). Nenhum bundle anterior a esta fatia pode responder esta string.
 */
export const VERSAO = "v1.1-paginacao-eof-e-cursor";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge grava de-para de SKU do fornecedor Sayerlack (RPC insert-only auditável); " +
  "mapeamento errado torna o item visível ao motor de reposição e vira compra do item errado";
