// Marcador de versão da edge `analyze-services`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: consome COTA DE IA do usuário (`ia_consumir_cota`, que grava em
// `ia_uso_evento`), LÊ `omie_servicos` e chama a Anthropic com o texto do pedido. Não escreve
// em tabela de aplicação — o pedido é montado no app, com a resposta.
//
// POR QUE ENTROU (2026-09-06): mesma classe cega da `identify-tool` — fora do mapa de
// fingerprints, sem canária, e sem via passiva possível. Ela não escreve NADA de aplicação
// (o único `.from` é leitura), então a via do #2086 (escrita como assinatura do bundle) não
// existe aqui, e `ia_uso_evento` é purgada aos 7 dias. Era a edge mais opaca das quatro.
//
// ⚠️ `verify_jwt = true` — esta é a ÚNICA das quatro edges de IA ausente do `config.toml`, logo
// a única em que o GATEWAY exige JWT antes do handler. Quem sonda precisa mandar um
// `Authorization: Bearer <jwt>` além do `x-cron-secret`: o anon key serve, mas um relé que só
// mande o secret recebe 401 DO GATEWAY, sem nunca tocar este arquivo — e esse 401 não distingue
// bundle velho de credencial faltando.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR: BARATO, AMBÍGUO. Sem `Authorization: Bearer ` o bundle velho
// responde 401 `Não autorizado` antes do `req.json()` — nenhum token gasto, nenhuma cota
// queimada. 401 é o 4xx ambíguo; só o 200 com `probe:true` é veredito positivo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("analyze-services");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge queima cota de IA do usuário e chama a Anthropic com o texto do pedido";
