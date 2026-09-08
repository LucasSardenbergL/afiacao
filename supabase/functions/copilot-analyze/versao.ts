// Marcador de versão da edge `copilot-analyze`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: consome COTA DE IA do usuário (`ia_consumir_cota`, que grava em
// `ia_uso_evento`) e chama a Anthropic com a transcrição da conversa. As linhas de
// `farmer_copilot_sessions`/`farmer_copilot_events` são escritas pelo APP, não por aqui.
//
// POR QUE ENTROU (2026-09-06): entrou junto com as outras três de IA, por consistência de
// cobertura — mas é a única das quatro cuja pergunta ("está sendo usada?") já tinha resposta
// sem sonda: `farmer_copilot_sessions` está em 0 desde sempre e NÃO tem purga, e o app grava a
// sessão ANTES de invocar a edge, então zero sessões ⇒ zero chamadas. Denominador sólido, via
// #2086 (escrita de aplicação como sensor). A sonda acrescenta o que aquela via não dá: QUAL
// bundle está no ar, no dia em que a feature for ligada.
//
// ⚠️ SONDA SEM GATE PRÓPRIO — diferente das outras três: esta edge já abre com
// `authorizeCronOrStaff` (linha 24), que aceita `x-cron-secret`, então o bloco de sonda fica
// ATRÁS dele e não precisa repetir o gate. Mesmo desenho do `omie-sync`.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATO, AMBÍGUO. O bundle velho já responde 401 no
// `authorizeCronOrStaff` sem credencial e, com ela, 400 `transcript` curto antes da Anthropic —
// nenhuma cota queimada nos dois casos. 401 é o 4xx ambíguo; só o 200 com `probe:true` prova.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("copilot-analyze");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
//
// v1.2 (canária): ESTE bump acompanha mudança de comportamento — a edge passou a responder
// `{"canary":true}` executando as fixtures de `canaria.ts` (ver o bloco no `index.ts`). O bump
// ANTERIOR (`v1.1-piloto-mcp-lovable`) não acompanhava nenhuma, e isso era o desenho: ele era o
// ANTES CONHECIDO do piloto do deploy por MCP do Lovable — bumpar o marcador muda o `versao.ts`,
// que está no closure, logo muda TAMBÉM o `fonte`, e a edge caía em `DIVERGE_P1` MEDIDO (par ≠
// par) em vez de `NUNCA_ATESTADA`, que é ausência de dado. Sem esse antes, "o MCP deployou" e "já
// estava idêntico" produziam o MESMO eco. Esta edge é a cobaia porque o custo de errar é zero:
// gate `authorizeCronOrStaff`, `verify_jwt = false` (sem 401 ambíguo do gateway), nenhuma escrita
// de aplicação, e `farmer_copilot_sessions` MEDIDA em 0 (com controle positivo) — a feature nunca
// foi ligada. Desfecho do piloto: `docs/historico/piloto-deploy-mcp-lovable.md`.
//
// ⚠️ O `VERSAO` e o `contrato` da canária são marcadores DIFERENTES e não se substituem: este
// diz QUAL bundle respondeu (declarado), o `contrato` diz O QUE o verde está afirmando (medido).
// Os gates são irmãos e independentes — `sonda:bump` vigia este, `canaria:bump` vigia aquele.
export const VERSAO = "v1.2-canaria-tudo-ou-nada";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge queima cota de IA do usuário e chama a Anthropic com a transcrição da conversa";
