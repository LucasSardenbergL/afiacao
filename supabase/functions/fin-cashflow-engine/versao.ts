// Marcador de versão da edge `fin-cashflow-engine`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge, com a ressalva que importa: a escrita é CONDICIONAL a
// `save_snapshot: true` — que é justamente o caminho do cron diário. Nele ela grava
// `fin_projecao_snapshots` e abre/atualiza/dispensa linhas em `fin_alertas`, tudo via
// `escritaCritica`. Com `save_snapshot` ausente ou false não escreve nada.
//
// Por que a sonda mesmo assim: o snapshot é a projeção de caixa de 13 semanas que a gestão lê
// para decidir pagamento e captação — um bundle velho aqui não devolve erro, devolve NÚMERO
// errado, e o número entra no snapshot com carimbo de hoje. E mesmo o caminho read-only paga a
// projeção inteira antes de responder, então "chamar para ver a versão" nunca foi barato.
//
// O gate desta edge é um `authorizeCronOrStaff` INLINE (não o de `_shared/auth.ts`), e ele JÁ
// aceita `x-cron-secret`: a sonda entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge roda a projeção de caixa de 13 semanas e, no caminho do cron (save_snapshot:true), " +
  "grava fin_projecao_snapshots e abre/atualiza fin_alertas — a projeção que a gestão lê para " +
  "decidir pagamento e captação passa a ter o número deste run, carimbado de hoje";
