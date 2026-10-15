// Marcador de versão da edge `structure-customer-process`.
// Classificador da sonda (compartilhado): `_shared/sonda-versao.ts`.
//
// Estrutura, com o modelo da Anthropic, o processo de compra descrito em texto livre pelo cliente (admin-CRM, módulo ativo). Não escreve no banco.
// Ficou sem sonda até 2026-10-14: sem ela, nenhum deploy desta edge tinha prova de estar no ar.
//
// O gate `authorizeCronOrStaff` já aceita `x-cron-secret`: a sonda vem depois dele e antes da leitura da chave e da chamada ao modelo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("structure-customer-process");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge manda a descrição livre do processo do cliente para o modelo da Anthropic — token pago por chamada";
