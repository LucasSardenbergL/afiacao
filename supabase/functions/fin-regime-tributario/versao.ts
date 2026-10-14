// Marcador de versão da edge `fin-regime-tributario`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Otimizador Tributário — compara Simples × Presumido × Real por empresa + consolidado. Leitura pura: não escreve.
// Ficou sem sonda até 2026-10-14: sem ela, nenhum deploy desta edge tinha prova de estar no ar
// (plano de melhorias 2026-09-05, §0.4 Lote C — as 4 do financeiro de leitura).
//
// O gate desta edge é `authorizeMaster (Bearer + role master)`, que NÃO aceita `x-cron-secret` — o caminho do SQL Editor
// (`net.http_post`) morreria nele (o furo da `recommend`, #1882). A sonda entra com gate PRÓPRIO
// (`authorizeCronOrStaff`) antes do gate normal e de qualquer IO — GATE_PROPRIO.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-regime-tributario");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge recalcula a carga tributária das 3 empresas nos três regimes a partir da DRE; não escreve, mas devolve a comparação que embasa a escolha de regime — e uma leitura incompleta vira economia ou custo fabricado";
