// Marcador de versão da edge `sync-reprocess`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Oitava leva (#1889/#1901, paginação): uma das 7 edges dependentes do `_shared/paginate.ts` sem
// sensor nenhum. No-op por DESENHO ⇒ só o marcador prova o deploy
// (`docs/historico/deploy-no-op-por-desenho.md`).
//
// CUSTO DO BUNDLE VELHO IGNORANDO `probe`: BAIXO — a única das sete nessa condição, e por desenho,
// não por sorte. Ela roteia por `action`, e um corpo sem `action` conhecida cai no
// `default: 400 "Ação desconhecida"`. O bundle pré-sensor paga só o `createClient` e UMA leitura de
// config (`loadReprocessConfig`) antes de recusar — nenhuma escrita, nenhuma chamada ao Omie. Mesma
// propriedade que tornou baratas as sondas da `omie-analytics-sync` e da `omie-financeiro`, e o
// veredito fica binário:
//     {ok,probe:true,versao,edge}   → bundle COM sensor
//     400 "Ação desconhecida"       → bundle PRÉ-sensor, o deploy não subiu
//
// O gate é `authorizeCron` (só `x-cron-secret`, comparação de env pura) — aceita exatamente o
// caminho do SQL Editor, então a sonda vem DEPOIS dele e não precisa de gate próprio.
//
// ⚠️ O parse do corpo SUBIU para antes do `createClient` (o gate estrutural de FORMA exige que a
// sonda responda antes dele), e o corpo de um `Request` só se lê UMA vez. O `throw` de um JSON
// inválido é PRESERVADO e relançado no ponto antigo, para que a resposta continue sendo o 500 do
// catch geral — mudar isso trocaria a mensagem de erro de quem manda corpo quebrado.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sync-reprocess");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reprocessa pedidos, produtos e estoque do Omie: DELETA e reinsere order_items, " +
  "atualiza sales_orders e faz upsert em product_costs — a tabela de custo que a margem e o motor " +
  "de recomendação leem; um run não pedido reescreve custo e item de pedido usando a janela de " +
  "dias que a config resolver sozinha, e o order_items apagado não volta pela mesma chamada";
