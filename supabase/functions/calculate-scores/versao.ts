// Marcador de versão da edge `calculate-scores`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Oitava leva (#1889/#1901, paginação): das 19 edges que servem o `_shared/paginate.ts`, esta era
// uma das 7 SEM sensor nenhum — logo o deploy dela era INVERIFICÁVEL. O #1889 é no-op por DESENHO
// (`docs/historico/deploy-no-op-por-desenho.md`): enquanto o `max-rows` de prod for 1000, bundle
// novo e velho devolvem os MESMOS bytes, então nenhuma canária de comportamento discrimina. Só o
// marcador prova — e ele tem de existir ANTES do deploy, não depois.
//
// CUSTO DO BUNDLE VELHO IGNORANDO `probe`: ALTO. Ela não lê o corpo da requisição em versão
// nenhuma anterior a esta, e o gate (`authorizeCronOrStaff`) ACEITA o `x-cron-secret` do SQL
// Editor — então a sonda às cegas passa direto pelo gate e dispara o RUN COMPLETO: toma o lease de
// 15 min, relê a base e aplica `apply_score_updates`. Não sonde antes de confirmar o deploy por
// outro meio; a resposta do fluxo real é indistinguível de "bundle velho" (armadilha 1 de
// `docs/agent/deploy.md` §Canárias), e nesta edge ela ainda custa uma reescrita de score.
//
// O gate aceita `x-cron-secret` por comparação de env pura ⇒ a sonda vem DEPOIS dele e não precisa
// de gate próprio; ela só tem de responder ANTES do `createClient` (gate estrutural de FORMA).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("calculate-scores");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge recalcula TODOS os farmer_client_scores (health_score, churn_risk, m_score, margem, " +
  "recência) e aplica via a RPC apply_score_updates, gravando ainda health_score_history e " +
  "priority_score_log; um run não pedido toma o lease de 15 min e sobrescreve o snapshot inteiro " +
  "— e dois runs sobrepostos fazem last-writer-wins, restaurando margem velha por cima da nova";
