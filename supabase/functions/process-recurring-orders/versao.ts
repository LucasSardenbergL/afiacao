// Marcador de versão da edge `process-recurring-orders`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: cria PEDIDO de verdade para o cliente — `insert` em `orders` com `status:
// 'pedido_recebido'` — para cada agendamento recorrente vencido, e AVANÇA o `next_order_date` do
// agendamento.
//
// Entrou na 12ª leva (2026-09-05) pelo critério "escrita money-path no NOSSO banco", e é a
// continuação da 11ª: ela também estava na CLASSE CEGA do Passo 3 do `/fecho` — fora do mapa de
// fingerprints E importando `_shared/`, logo invisível para as vias (a) e (b) do
// `edges-pendentes.sh`. A via (c) (grafo de imports, #2170) fechou a ENUMERAÇÃO; o `versao.ts` é o
// que dá SUPRESSÃO por evidência positiva servida.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): CARA — não sonde às cegas, e é a mais cara das três. Ela não lê o
// corpo NENHUM: `{"probe":true}` executa o tick inteiro. O dano é DUPLO — cria pedidos que ninguém
// pediu E avança o `next_order_date`, então o run legítimo do dia seguinte PULA a data que a sonda
// consumiu. Rollback não desfaz nenhum dos dois.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("process-recurring-orders");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge CRIA pedido de verdade (insert em orders, status pedido_recebido) para cada " +
  "agendamento recorrente vencido e AVANÇA o next_order_date — o run legítimo seguinte pula " +
  "a data já consumida";
