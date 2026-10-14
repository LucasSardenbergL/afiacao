// Marcador de versão da edge `fin-valor-engine`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// A2 — Retorno & Valor (ROIC/WACC/EVA), master-only. Leitura pura: não escreve.
// Ficou sem sonda até 2026-10-14: sem ela, nenhum deploy desta edge tinha prova de estar no ar
// (plano de melhorias 2026-09-05, §0.4 Lote C — as 4 do financeiro de leitura).
//
// O gate desta edge é `authorizeMaster (Bearer + role master)`, que NÃO aceita `x-cron-secret` — o caminho do SQL Editor
// (`net.http_post`) morreria nele (o furo da `recommend`, #1882). A sonda entra com gate PRÓPRIO
// (`authorizeCronOrStaff`) antes do gate normal e de qualquer IO — GATE_PROPRIO.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-valor-engine");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge calcula ROIC/WACC/EVA lendo a DRE TTM e os inputs sensíveis de valor (master-only); não escreve, mas devolve o número que a gestão usa para decidir alocação de capital — e uma leitura incompleta não vira erro, vira número com a mesma cara de certo";
