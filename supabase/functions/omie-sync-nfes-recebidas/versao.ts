// Marcador de versão da edge `omie-sync-nfes-recebidas`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela escreve o RASTREIO da nota contra o pedido de compra —
// `purchase_orders_tracking` (insert e update) e `fin_sync_log`. É o que fecha o ciclo
// "pedido disparado → nota chegou", e portanto o que o financeiro e a reposição leem para saber
// o que ainda está em trânsito.
//
// Por que a sonda importa aqui: além da escrita, o run é PESADO — enumera recebimentos e faz
// N chamadas `ConsultarRecebimento` no Omie. Não existe caminho barato de perguntar "qual bundle
// está no ar" sem pagar essa varredura inteira. E `fin_sync_log` é lido SEM filtro de `action`
// por `_data_health_compute`/`fin_calcular_confiabilidade`: um run supérfluo fabrica frescor.
// Por isso a sonda responde ANTES do `createClient` — ela não abre linha em `fin_sync_log`.
//
// O gate desta edge é um `authorizeCronOrStaff` INLINE (não o de `_shared/auth.ts`), e ele JÁ
// aceita `x-cron-secret`: a sonda entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync-nfes-recebidas");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reescreve o rastreio nota-contra-pedido (purchase_orders_tracking) e abre linha em " +
  "fin_sync_log, que o cálculo de frescor lê SEM filtrar action — um run supérfluo fabrica " +
  "confiabilidade — e paga uma varredura pesada de N ConsultarRecebimento no Omie";
