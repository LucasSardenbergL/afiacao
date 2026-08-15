// Marcador de versão da edge `generate-tactical-plan`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTE ARQUIVO EXISTE — a sonda daqui NÃO nasceu hoje, ela nasceu CEGA (2026-08-14).
// O `{"probe":true}` já existia desde o #1618 (migração p/ Anthropic), mas respondia uma CONSTANTE
// (`motor:'anthropic'`), então provava só "bundle ≥ #1618" e mais nada. Todo deploy posterior
// respondia byte-idêntico: é a armadilha 2 de `docs/agent/deploy.md` §Canárias — sem version
// marker, a resposta não discrimina reversão de fatia e MENTE VERDE.
//
// Medido no fecho do FU4-F fase 3: o último commit a tocar esta edge é o `9f7e8962` (#1520), e a
// sonda responde IGUAL antes e depois dele. Não houve como provar o deploy; a verificação caiu em
// "o founder confirmou" — confirmação verbal, que o CLAUDE.md proíbe tratar como validação. O
// frontend do mesmo PR foi provado por bytes; a edge não tinha equivalente. Este marcador é o
// equivalente.
//
// ⚠️ O sensor só prova versões A PARTIR DE SI MESMO: um bundle anterior a este PR responde a sonda
// VELHA (sem `versao`). Ausência do campo = bundle pré-marcador, não "versão errada".

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

import { respostaSonda } from "../_shared/sonda-versao.ts";
import { MODELO, toolDoModo } from "./plano-helpers.ts";

/**
 * Marcador de versão servido pela edge. **Atualize a cada mudança relevante de comportamento** —
 * é ele que distingue um bundle novo de um velho em produção.
 *
 * `v1.0-custo-fora-do-browser` = o contrato do #1520 (FU4-F fase 3 PR-B: o custo sai do browser e
 * `product_costs` fecha). Nasce nomeando essa fatia de propósito: era a entrega que não se
 * conseguiu provar, e um bundle que responde este marcador é necessariamente ≥ este PR, que a
 * contém. A pergunta que ficou sem resposta em 2026-08-14 passa a ter uma.
 */
export const VERSAO = "v1.0-custo-fora-do-browser";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama o modelo Anthropic (custo por token) e GRAVA plano em farmer_tactical_plans";

/**
 * Corpo da sonda desta edge: o contrato compartilhado (`ok`/`probe`/`versao`) MAIS os campos que a
 * sonda do #1618 já servia.
 *
 * Os quatro campos antigos ficam de propósito — a sonda é um SUPERSET, não uma troca. Quem tiver o
 * `curl` do #1618 anotado (o comentário que estava no `index.ts` documentava exatamente esse
 * comando) continua lendo `motor:'anthropic'` e concluindo a mesma coisa; o que muda é que agora
 * existe também a resposta para "qual versão?". Remover algum deles quebraria uma verificação que
 * já está em uso sem melhorar em nada a nova.
 */
export function respostaSondaTactical(): {
  ok: true;
  probe: true;
  versao: string;
  motor: "anthropic";
  modelo: string;
  tool: string;
  fallback_fabricado: false;
} {
  return {
    ...respostaSonda(VERSAO),
    motor: "anthropic",
    modelo: MODELO,
    tool: toolDoModo("estrategico").name,
    fallback_fabricado: false,
  };
}
