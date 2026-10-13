// Marcador de versão da edge `fin-ic-reconcile`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26, 3ª leva do Lote C (plano de melhorias): edge ATIVA com escrita e sem prova de deploy.
// Contexto: cron diário `fin-ic-reconcile-daily` (0 9 * * *), o único cron ativo da classe.
// O gate (`authorizeCronOrStaff`) já aceita `x-cron-secret` ⇒ sem gate próprio.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: CARA — o bundle velho não lê o corpo, então `{"probe":true}` roda a
// conciliação intercompany inteira (lê CR/CP e regrava os matches). Use `--caro` só sabendo disso.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-ic-reconcile");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge concilia as contas a receber e a pagar ENTRE as empresas do grupo e REGRAVA os matches" +
  " intercompany (fin_ic_matches) — o DRE consolidado elimina por eles";
