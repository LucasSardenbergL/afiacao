// Marcador de versão da edge `fin-period-override`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26, 3ª leva do Lote C (plano de melhorias): edge ATIVA com escrita e sem prova de deploy.
// Contexto: chamada pelo browser (master) para abrir override de período fechado.
// O gate (`authorizeCronOrStaff`) aceita `x-cron-secret` ⇒ sem gate próprio.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATA — `{"probe":true}` não tem os campos obrigatórios e cai no
// 400 antes de escrever.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-period-override");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge ABRE override de período financeiro fechado (fin_period_overrides) — reabre a escrita num" +
  " mês que o fechamento travou";
