// Marcador de versão da edge `whatsapp-inbound`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: recebe o webhook da 360dialog e, com o `x-whatsapp-secret` certo, grava o
// payload bruto em `whatsapp_webhook_events`, cria/atualiza `whatsapp_conversations` — inclusive o
// `opt_in_status`, onde o STOP do cliente vira `opt_out` (LGPD) —, insere `whatsapp_messages` e
// avança o status de entrega em `whatsapp_messages`/`whatsapp_template_sends`.
//
// Entrou na 13ª leva (2026-09-26) pelo critério "não existe caminho de prova": quem chama é a
// 360dialog, não cron nem browser, então não há rastro em `net._http_response`; e o log próprio
// (`whatsapp_webhook_events`) é gravado por TODAS as versões, logo não discrimina bundle. Medido na
// entrada: a versão servida era INDETERMINADA entre v0 (#479/#513, aceitava o segredo por
// `?token=`), v1 (#1123, só header) e v2 (#1316, processa `statuses[]`) —
// docs/historico/whatsapp-inbound-sem-prova-edicao-de-tipo.md.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (a triagem de `docs/agent/deploy.md` §"O CUSTO da sonda, edge a
// edge", que decide `--caro`): BARATA porém AMBÍGUA. O gate do fluxo real é `x-whatsapp-secret`, que
// o SQL Editor não emite, então as três versões pré-sensor devolvem 401 ANTES de qualquer I/O —
// seguro de disparar antes ou depois do deploy. Mas 401 não distingue "bundle velho" de "credencial
// errada": cruze com `controle_credencial`, como manda o bloco gerado pelo `sonda:sql`.
//
// Fora da sonda por cron (`_shared/sonda-cron-alvos.ts`) de propósito: o ramo do relé exige um
// bloco `OPTIONS` com CORS, e esta edge é webhook servidor-a-servidor, sem preflight nenhum.
// Mudar o `OPTIONS` só para caber no relé não vale — a atestação vem de uma sonda por leva.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("whatsapp-inbound");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge grava o webhook bruto em whatsapp_webhook_events, cria conversas e mensagens e " +
  "atualiza o opt-in/opt-out (LGPD) e o status de entrega dos templates enviados";
