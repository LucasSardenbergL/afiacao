// Marcador de versão da edge `omie-cron-diario` — o orquestrador do jobid 52
// (`afiacao_omie_oben_sync_incremental_2h`, `15 */2 * * *`).
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE GANHOU SONDA (2026-09-24): os 5 steps dela ganharam sensor em 2026-08-27
// (#2063), o orquestrador não. Ficou inverificável justamente quando uma fatia muda a LISTA de
// steps: a de 2026-09-24 tirou o `omie-sync-sku-items` daqui (a chamada `ConsultarRecebimento`
// IDÊNTICA à que o step NFe acabara de fazer voltava "Consumo redundante (REDUNDANT)" — 46 runs
// `error` falsos em 30 dias) e deu a ele cron próprio no minuto :35. Sem marcador, o deploy desse
// corte só se provaria pela AUSÊNCIA de `resultados.sku_items` no corpo — e ausência é a assinatura
// de qualquer coisa, inclusive de um step que abortou.
//
// Efeito desta edge: ela não escreve nada DIRETAMENTE — ela CHAMA, em série, 4 edges que escrevem
// (pedidos de compra, NFes recebidas, CTes, itens de venda: `purchase_orders_tracking` e cia.) e 2
// RPCs de reposição (`atualizar_classificacao_skus` e `aplicar_parametros_automatico_diario`, esta
// com guarda de UMA execução por dia BRT). Um disparo acidental aparece nas edges de baixo, não aqui.
//
// O CAMINHO PASSIVO: o `jsonRes` do `index.ts` anexa `versao/edge/fonte` a TODA resposta, e o
// jobid 52 chama esta edge DIRETO a cada 2h — o corpo que fica em `net._http_response` já carrega o
// marcador no TOPO, sem orquestrador acima dele. O coletor do ledger (`deploy_atestacoes_colher`)
// o copia; nada precisa ser invocado para provar o deploy.
//
// ⚠️ SONDAR ESTA EDGE PRÉ-SENSOR DISPARA O CICLO INTEIRO: o bundle velho não conhece `probe`, cai no
// default `empresa:"OBEN"` e roda os 5 steps + as 2 RPCs. Só sonde DEPOIS de confirmar o deploy — ou
// leia o marcador pelo caminho passivo acima.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-cron-diario");

/** A identidade desta edge, para o ECO carregá-la junto do `versao` (ver o `versao.ts` do
 *  `omie-sync-sku-items` para o porquê: a chave que um pai escolhe não prova quem respondeu). */
export const EDGE = "omie-cron-diario";

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * v1.0 nasce NOMEANDO a fatia que motivou o sensor: a lista de steps sem o `sku_items`.
 */
export const VERSAO = "v1.0-sem-step-sku-items";

/** O fingerprint da FONTE, para o ECO carregá-lo também (derivado — o CI regrava o mapa). */
export const FONTE = respostaSonda(VERSAO).fonte;

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge dispara em série 4 syncs Omie que escrevem no banco (pedidos de compra, NFes " +
  "recebidas, CTes, itens de venda — purchase_orders_tracking e cia.) e 2 RPCs de reposição " +
  "(atualizar_classificacao_skus e aplicar_parametros_automatico_diario), além de pagar a cota " +
  "Omie de cada step; um run supérfluo também abre linhas em fin_sync_log, que o cálculo de " +
  "frescor lê SEM filtrar action";
