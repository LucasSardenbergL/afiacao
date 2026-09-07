// Marcador de versão da edge `dispatch-notifications`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: processa a fila de fornecedor_alerta enviando e-mail pela Gmail API e criando evento no Google Calendar do time. E-mail enviado e convite criado não se desfazem.
//
// Entrou na 11ª leva (2026-09-05) pelo critério "efeito FORA do nosso banco" (#1753): o que ela
// dispara não se desfaz com rollback. Mas o motivo IMEDIATO é outro e vale registrar — ela estava
// na classe cega do Passo 3 do `/fecho`: fora do mapa de fingerprints E importando `_shared/`,
// logo invisível para as vias (a) e (b) do `edges-pendentes.sh`. A via (c) (grafo de imports)
// fechou a ENUMERAÇÃO; o `versao.ts` é o que dá SUPRESSÃO por evidência positiva servida.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("dispatch-notifications");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge envia e-mail pelo Gmail e cria evento no Google Calendar";
