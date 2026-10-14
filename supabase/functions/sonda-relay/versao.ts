export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sonda-relay");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
// v1.2 (onda 6, 2026-10-13): a allowlist ganha `picking-fila-omie` — o relé só a aceita em runtime
// depois do deploy desta versão.
export const VERSAO = "v1.2-alvos-da-onda-6";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge faz UMA requisição OPTIONS na edge-alvo da allowlist com a credencial de sonda e " +
  "devolve o corpo da atestação; não escreve em banco, não chama ERP e não envia mensagem — o " +
  "custo de um disparo indevido é uma linha a mais em net._http_response, e o de um BUG aqui " +
  "(emitir POST em vez de OPTIONS) seria o fluxo real da alvo, que é o que a barreira impede";
