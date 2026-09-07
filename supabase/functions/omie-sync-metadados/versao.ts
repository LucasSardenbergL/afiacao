// Marcador de versão da edge `omie-sync-metadados`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: reescreve o catálogo `omie_products` (upsert por página) e CARIMBA o marcador
// de frescor `sync_state` com `last_sync_at`/`last_page`.
//
// Entrou na 12ª leva (2026-09-05) pelo critério "escrita money-path no NOSSO banco", e é a
// continuação direta da 11ª: ela também estava na CLASSE CEGA do Passo 3 do `/fecho` — fora do
// mapa de fingerprints E importando `_shared/`, logo invisível para as vias (a) e (b) do
// `edges-pendentes.sh`. A via (c) (grafo de imports, #2170) fechou a ENUMERAÇÃO; o `versao.ts` é o
// que dá SUPRESSÃO por evidência positiva servida.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): CARA — não sonde às cegas. Sem `accounts` no corpo o default é
// `["vendas","colacor_vendas"]`, então `{"probe":true}` sincroniza as DUAS contas inteiras. E o run
// avança `sync_state`: um run ruim apaga o sinal de que foi ruim (a mesma armadilha da
// `omie-sync-estoque`).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync-metadados");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reescreve o catálogo omie_products das duas contas e carimba o marcador de " +
  "frescor sync_state — o run parcial apaga o sinal de que foi parcial";
