// Marcador de versão da edge `biometric-auth`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// M-26 (Lote C do plano de melhorias): edge com escrita e sem prova de deploy.
// O fluxo é PRÉ-LOGIN e público (só rate limit), então não há gate que aceite `x-cron-secret`.
// A sonda entra com gate PRÓPRIO (`authorizeCronOrStaff`), e só para corpo de sonda — GATE_PROPRIO.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("biometric-auth");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sonda";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge valida a asserção WebAuthn e GRAVA a credencial biométrica (webauthn_credentials) " +
  "do login sem senha — o efeito é alterar como alguém entra no app";
