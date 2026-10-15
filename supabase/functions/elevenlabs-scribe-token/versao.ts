// Marcador de versão da edge `elevenlabs-scribe-token`.
// Classificador da sonda (compartilhado): `_shared/sonda-versao.ts`.
//
// Emite o token temporário do ElevenLabs Scribe para o copilot de voz do farmer (módulo ativo). Não escreve no banco.
// Ficou sem sonda até 2026-10-14: sem ela, nenhum deploy desta edge tinha prova de estar no ar.
//
// O gate `authorizeCronOrStaff` já aceita `x-cron-secret`, mas DEPOIS dele o handler testa `startsWith("Bearer ")` de usuário: a sonda vem entre os dois (BEARER_NO_HANDLER), senão o SQL Editor nunca a alcança.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("elevenlabs-scribe-token");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge emite um token de transcrição do ElevenLabs — credencial paga, de uso único — para o copilot de voz";
