// Marcador de versão da edge `monthly-report`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE ENTRA — ela não cita `_shared/paginate.ts` em lugar nenhum. Chega ao helper por
// UM salto (`_shared/relatorio-mensal.ts`, que importa `fetchAll`), e por isso o
// `git grep -l "_shared/paginate.ts"` a perdia: a relação é de GRAFO e o grep é local. Ver
// `docs/historico/enumerar-consumidores-de-helper.md`. O bundle carrega o helper do mesmo jeito.
//
// ⚠️ EFEITO DO BUNDLE VELHO IGNORANDO `probe` — é o pior desta leva, e é o que trava a ORDEM.
// Um bundle pré-sonda não conhece a chave `probe`: ele segue para o fluxo real e lê o corpo como
// pedido de relatório. Os defaults conspiram, cada um sozinho razoável:
//   `targetUserId = body.user_id`            -> undefined  => TODA a base (5.276 perfis), não um
//   `sendEmail   = body.send_email !== false`-> TRUE       => envio ARMADO por omissão
//   `previewOnly = body.preview_only === true`-> false      => nada segura
// ou seja, `{"probe":true}` num bundle velho dispara o relatório mensal por e-mail para a base
// inteira, fora de época, via `fetch` real na Resend. E-mail enviado não volta: não é número
// errado que se recalcula, é mensagem que chegou no cliente. Daí a regra desta edge ser
// ORDEM, não higiene: **deploy primeiro, sonda depois** — nunca sondar às cegas para "ver se subiu".
//
// ⚠️ O sensor só prova versões A PARTIR DE SI MESMO: um bundle anterior a este PR não responde
// `probe:true`. Ausência do eco = bundle pré-sensor — e ele executou o envio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("monthly-report");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge ENVIA o relatório mensal por e-mail aos clientes via Resend (fetch real na " +
  "api.resend.com), e os defaults do corpo armam o envio por OMISSÃO: sem `user_id` o alvo é a " +
  "base inteira (5.276 perfis) e `send_email` ausente vale TRUE, então um `probe` mal grafado " +
  "não erra um número — manda e-mail fora de época para todo cliente com endereço, e mensagem " +
  "entregue não se desfaz";
