// Marcador de versão da edge `enviar-pedido-portal-sayerlack`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito irreversível desta edge: ela SUBMETE o pedido no portal do fornecedor via Browserless —
// o fornecedor recebe de verdade, e não há desfazer. Depois disso ainda chama
// `disparar-pedidos-aprovados` para registrar o PO no Omie. Não existe caminho de diagnóstico
// barato sem a sonda.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("enviar-pedido-portal-sayerlack");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * `v1.1-pos-login-no-envio` (8ee8afa15): o pós-login deixou de inferir sucesso de `url_changed` e passou a
 * classificar por SINAIS do DOM (menu do sidebar e campos de senha), via `_shared/sayerlack-pos-login.ts`. Antes, troca de
 * senha exigida pelo portal virava exceção — o `url_changed` mudava e lia como dashboard.
 *
 * ⚠️ Este bump é TARDIO: o 8ee8afa15 mergeou em 2026-08-21 e o marcador ficou em
 * `v1.0-sensor-inicial`, então a sonda não discriminava aquele deploy. Ele NÃO recupera a
 * discriminação perdida — reata só o sentido positivo, do próximo deploy em diante
 * (`docs/historico/sonda-marcador-congelado.md`).
 */
export const VERSAO = "v1.1-pos-login-no-envio";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge SUBMETE o pedido no portal do fornecedor (Browserless) — o fornecedor recebe de verdade";
