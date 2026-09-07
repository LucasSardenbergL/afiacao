// Marcador de versão da edge `identify-tool`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: consome COTA DE IA do usuário (`ia_consumir_cota`, que grava em
// `ia_uso_evento`) e chama a Anthropic com uma foto de até 8 MB. Não escreve mais nada — a
// ferramenta identificada só vira linha em `user_tools` se o usuário salvar o formulário, do
// lado do app.
//
// POR QUE ENTROU (2026-09-06): esta edge estava na CLASSE CEGA — fora do mapa de fingerprints e
// sem canária —, e a pergunta que motivou a instrumentação não tinha resposta possível: "o gate
// de cota do #1646 está NO AR aqui, ou só na main?". As duas vias tentadas falharam por desenho:
// `ia_uso_evento` é PURGADA aos 7 dias (cron `ia-uso-evento-purga`), então ausência de linha
// nunca prova bundle velho E a presença expira; e o caminho pré-auth do bundle com cota é
// idêntico ao sem cota (o `consumirCota` vem depois do `getUser`), então não há canária
// anônima. O `fonte` servido aqui é função do CONTEÚDO e não vence.
//
// ⚠️ SONDAR O BUNDLE PRÉ-SENSOR (triagem de `docs/agent/deploy.md` §"O CUSTO da sonda"): BARATO,
// AMBÍGUO. Sem `Authorization: Bearer ` o bundle velho responde 401 `Não autorizado` nas linhas
// 32-38, ANTES do `req.json()` — nenhum token gasto, nenhuma cota queimada. Mas 401 é o único
// 4xx ambíguo (bundle pré-sonda *ou* credencial errada), então só o 200 com `probe:true` é
// veredito positivo.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("identify-tool");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge queima cota de IA do usuário e chama a Anthropic com a foto enviada";
