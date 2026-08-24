// Marcador de versão da edge `scoring-recalc-batch`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Oitava leva (#1889/#1901, paginação): uma das 7 edges dependentes do `_shared/paginate.ts` sem
// sensor nenhum. No-op por DESENHO ⇒ só o marcador prova o deploy
// (`docs/historico/deploy-no-op-por-desenho.md`).
//
// CUSTO DO BUNDLE VELHO IGNORANDO `probe`: ALTO, e ele TRANSBORDA para outra edge. Ela não lê o
// corpo em versão nenhuma anterior a esta, e o gate (`authorizeCronOrStaff`) aceita o
// `x-cron-secret` do SQL Editor: a sonda às cegas vira um run completo de fan-out — drena até 500
// da fila e dispara `scoring-recalc-client` por cliente com atividade em 30 d, cada chamada
// atualizando `farmer_client_scores`. O efeito não fica contido nesta edge, o que torna o rastro
// mais difícil de ler depois. Confirme o deploy por outro meio antes de sondar.
//
// A sonda vem DEPOIS do gate (comparação de env pura com cron-secret) e ANTES do `createClient`.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("scoring-recalc-batch");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge é o fan-out do scoring: drena até 500 da fila pendente e dispara " +
  "scoring-recalc-client por cliente com atividade nos últimos 30 dias, e cada uma dessas chamadas " +
  "atualiza farmer_client_scores — o score que ordena a carteira do vendedor; um run não pedido " +
  "recalcula fora da janela do cron e o efeito cai numa SEGUNDA edge, não nesta";
