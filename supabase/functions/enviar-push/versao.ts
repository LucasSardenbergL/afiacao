// Marcador de versão da edge `enviar-push`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: envia push notification (Web Push/VAPID) a todos os dispositivos inscritos do alvo. Notificação entregue não se recolhe do aparelho.
//
// Entrou na 11ª leva (2026-09-05) pelo critério "efeito FORA do nosso banco" (#1753): o que ela
// dispara não se desfaz com rollback. Mas o motivo IMEDIATO é outro e vale registrar — ela estava
// na classe cega do Passo 3 do `/fecho`: fora do mapa de fingerprints E importando `_shared/`,
// logo invisível para as vias (a) e (b) do `edges-pendentes.sh`. A via (c) (grafo de imports)
// fechou a ENUMERAÇÃO; o `versao.ts` é o que dá SUPRESSÃO por evidência positiva servida.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("enviar-push");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge envia push notification aos dispositivos inscritos";
