// Marcador de versão da edge `omie-malha-sync`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: reescreve a malha de estruturas do PCP em `pcp_malha_staging` (a lista técnica
// que vira necessidade de compra) e publica o run em `pcp_run_logs`.
//
// Entrou na 12ª leva (2026-09-05) pelo critério "escrita money-path no NOSSO banco", e é a
// continuação direta da 11ª: ela também estava na CLASSE CEGA do Passo 3 do `/fecho` — fora do
// mapa de fingerprints E importando `_shared/`, logo invisível para as vias (a) e (b) do
// `edges-pendentes.sh`. A via (c) (grafo de imports, #2170) fechou a ENUMERAÇÃO; o `versao.ts` é o
// que dá SUPRESSÃO por evidência positiva servida.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): BARATA. `action` ausente cai no default LITERAL `"probe"` da própria
// edge — que é diagnóstico read-only (`ListarEstruturas`, página 1, 2 registros) e devolve 200 com
// as chaves do payload do Omie. ⚠️ Note a colisão de nomes: o `action:"probe"` DELA inspeciona a
// forma do Omie; a sonda de versão decide pelo campo `probe` do corpo e é outra coisa.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-malha-sync");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reescreve a malha de estruturas do PCP em pcp_malha_staging, a lista técnica " +
  "de onde sai a necessidade de compra";
