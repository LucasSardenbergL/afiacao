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

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-cashflow-engine");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
//
// v1.0 → v1.1: o #1889 mudou `_shared/paginate.ts`, que esta edge importa — EOF passou a ser página
// VAZIA (não CURTA) e o offset avança pelas linhas REAIS devolvidas. O bump não é cosmético: ele é a
// ÚNICA prova possível deste deploy. O #1889 é deliberadamente no-op nos dados de hoje (o `max-rows`
// de prod é 1000, igual ao `PAGE` do helper — o comportamento antigo funciona por coincidência
// numérica), então NENHUMA canária de comportamento consegue discriminar bundle novo de velho aqui:
// os dois produzem bytes idênticos. Sem mexer no marcador, a sonda responderia "v1.0-sensor-inicial"
// tendo o deploy acontecido ou não — o "mente verde" da ⚠️ #2 de docs/agent/deploy.md.
// v1.4 → v1.5: PME e NCG com estoque de GIRO do Omie (fin_estoque_giro_valor) em vez de 0 fabricado
// por fin_estoque_valor vazia; CMV exige os 12 meses fechados; PME/estoque viram null + motivo.
// v1.5 → v1.6: baixa CR derivada lida em UMA chamada (RPC fin_titulo_baixas_cr_mapa) em vez de
// paginar v_titulo_baixas — cada página reavaliava a view inteira e a colacor dava 57014 (500).
// v1.6 → v1.7: PMR/PMP lidos pela RPC fin_capital_giro_prazos_empresa (O(empresa)) em vez da view
// v_capital_giro_prazos, que varria fin_movimentacoes inteira 2× por chamada; deriva da cópia → 500.
export const VERSAO = "v1.7-prazos-rpc";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge roda a projeção de caixa de 13 semanas e, no caminho do cron (save_snapshot:true), " +
  "grava fin_projecao_snapshots e abre/atualiza fin_alertas — a projeção que a gestão lê para " +
  "decidir pagamento e captação passa a ter o número deste run, carimbado de hoje";
