// Marcador de versão da edge `tint-sync-agent`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26, 3ª leva do Lote C (plano de melhorias): edge ATIVA com escrita e sem prova de deploy.
// Contexto: roteada por PATH; a sonda responde só na ROTA RAIZ (`/tint-sync-agent`), que é onde o gerador
// bate e que nenhuma rota do agente usa. Gate PRÓPRIO: os gates da edge (token do agente desktop,
// JWT staff) não aceitam `x-cron-secret` — GATE_PROPRIO.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATA e INEQUÍVOCA — a raiz cai no `404 Unknown endpoint` antes
// de qualquer escrita.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("tint-sync-agent");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge recebe o catálogo, as fórmulas e as preparações do agente tintométrico e GRAVA o staging e a" +
  " promoção (tint_*), além de rodar a reconciliação (tint_run_reconciliation) — muda o preço do balcão";
