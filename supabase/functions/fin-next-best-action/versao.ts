// Marcador de versão da edge `fin-next-best-action`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// A4 — Próxima Melhor Ação. Não escreve: compõe A1/A2/A3 chamando outras edges com service_role.
// Ficou sem sonda até 2026-10-14: sem ela, nenhum deploy desta edge tinha prova de estar no ar
// (plano de melhorias 2026-09-05, §0.4 Lote C — as 4 do financeiro de leitura).
//
// O gate desta edge é `authorizeGestorOuMaster (Bearer + role comercial)`, que NÃO aceita `x-cron-secret` — o caminho do SQL Editor
// (`net.http_post`) morreria nele (o furo da `recommend`, #1882). A sonda entra com gate PRÓPRIO
// (`authorizeCronOrStaff`) antes do gate normal e de qualquer IO — GATE_PROPRIO.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-next-best-action");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge dispara em paralelo fin-cashflow-engine e fin-valor-engine para as 3 empresas e o cockpit de valor — sete invocações pesadas por chamada — para montar a recomendação de ação da gestão";
