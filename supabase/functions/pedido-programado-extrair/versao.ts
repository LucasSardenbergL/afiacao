// Marcador de versão da edge `pedido-programado-extrair`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: extrai o PDF do pedido de compra com o Claude (token pago), APAGA os itens já
// extraídos (`delete` em `pedidos_programados_itens`) e reinsere, e move o status do header.
//
// Entrou na 12ª leva (2026-09-05) pelo critério "escrita money-path no NOSSO banco", e é a
// continuação da 11ª: ela também estava na CLASSE CEGA do Passo 3 do `/fecho` — fora do mapa de
// fingerprints E importando `_shared/`, logo invisível para as vias (a) e (b) do
// `edges-pendentes.sh`. A via (c) (grafo de imports, #2170) fechou a ENUMERAÇÃO; o `versao.ts` é o
// que dá SUPRESSÃO por evidência positiva servida.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): BARATA e INEQUÍVOCA. `{"probe":true}` não traz
// `pedido_programado_id`, e o guard devolve 400 antes do Storage, antes da Anthropic e antes do
// delete dos itens.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("pedido-programado-extrair");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge paga tokens da Anthropic para extrair o PDF e APAGA os itens já extraídos " +
  "(delete + insert em pedidos_programados_itens) antes de reescrever o status do pedido " +
  "programado";
