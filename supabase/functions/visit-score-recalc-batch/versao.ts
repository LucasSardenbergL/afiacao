// Marcador de versão da edge `visit-score-recalc-batch`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Oitava leva (#1889/#1901, paginação): uma das 7 edges dependentes do `_shared/paginate.ts` sem
// sensor nenhum. No-op por DESENHO ⇒ só o marcador prova o deploy
// (`docs/historico/deploy-no-op-por-desenho.md`).
//
// CUSTO DO BUNDLE VELHO IGNORANDO `probe`: ALTO, e transborda para outra edge — gêmea da
// `scoring-recalc-batch` nisso. Não lê o corpo em versão anterior a esta, e o gate
// (`authorizeCronOrStaff`) aceita o `x-cron-secret` do SQL Editor: a sonda às cegas drena até 500
// da fila e dispara `visit-score-recalc-client` por cliente com atividade em 30 d, cada chamada
// fazendo upsert em `customer_visit_scores`. Confirme o deploy por outro meio antes de sondar.
//
// A sonda vem DEPOIS do gate (comparação de env pura com cron-secret) e ANTES do `createClient`.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("visit-score-recalc-batch");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge é o fan-out do score de VISITA: drena até 500 da fila pendente e dispara " +
  "visit-score-recalc-client por cliente com atividade nos últimos 30 dias, e cada uma dessas " +
  "chamadas faz upsert em customer_visit_scores — o score que ordena o roteiro do vendedor em " +
  "campo; um run não pedido reordena a rota do dia depois de ela já ter sido entregue";
