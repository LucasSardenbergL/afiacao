// Marcador de versão da edge `omie-webhook`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: grava o evento bruto do Omie em `omie_webhook_events` (dedup por `messageId`)
// e despacha o processamento em background via `EdgeRuntime.waitUntil`.
//
// Entrou na 12ª leva (2026-09-05) pelo critério "escrita money-path no NOSSO banco", e é a
// continuação direta da 11ª: ela também estava na CLASSE CEGA do Passo 3 do `/fecho` — fora do
// mapa de fingerprints E importando `_shared/`, logo invisível para as vias (a) e (b) do
// `edges-pendentes.sh`. A via (c) (grafo de imports, #2170) fechou a ENUMERAÇÃO; o `versao.ts` é o
// que dá SUPRESSÃO por evidência positiva servida.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): BARATA porém AMBÍGUA. O gate do fluxo real é `x-webhook-secret`, que
// o SQL Editor não emite, então o bundle pré-sensor devolve 401 — seguro de disparar, mas 401 é o
// 4xx que não distingue "bundle velho" de "credencial errada" (cruze com `controle_credencial`,
// como manda o bloco gerado pelo `sonda:sql`).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-webhook");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge grava o evento bruto do Omie em omie_webhook_events e dispara em background o " +
  "processamento que materializa o efeito dele";
