// Marcador de versão da edge `posthog-error-webhook`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26, 3ª leva do Lote C (plano de melhorias): edge ATIVA com escrita e sem prova de deploy.
// Contexto: webhook do PostHog (segredo `x-posthog-webhook-secret`, que o SQL Editor não
// emite) ⇒ gate PRÓPRIO só para corpo de sonda — GATE_PROPRIO.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATA — sem o segredo, 401 antes de qualquer I/O.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("posthog-error-webhook");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge recebe o alerta de erro do PostHog e ENFILEIRA o aviso ao time (enfileirar_erro_app) —" +
  " sondar sem guarda dispararia um alerta falso";
