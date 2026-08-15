// Marcador de versão da edge `generate-tactical-plan`.
//
// O classificador da sonda (money-path, idêntico em toda edge) mora em `_shared/sonda-versao.ts`.
// Aqui fica só o que é DESTA edge: a versão e a descrição do efeito que a recusa fail-closed cita.
//
// POR QUE O MARCADOR EXISTE AQUI (2026-08-14, auditoria do #1520): esta edge JÁ tinha dois
// sensores — a canária comportamental do helper de margem (#1498/#1553) e o probe de motor
// (#1592) — e NENHUM dos dois discrimina a fatia do #1520. É exatamente a armadilha 2 de
// `docs/agent/deploy.md` §Canárias: um deploy integralmente velho carrega o `expected` velho
// junto, compara velho×velho e responde verde. O probe de motor tem o mesmo furo: `motor:
// 'anthropic'` já era verdade no bundle do #1592, anterior ao #1520.
//
// O que o #1520 mudou aqui e nenhum sensor via: o topBundle passou a sair de `affinity_bundle`
// (adimensional, com `.not(...is null)` e `nullsFirst: false`) em vez de `lie_bundle`. As
// migrations da fase 3 nulificaram `lie_bundle`/`m_bundle` — e no Postgres `DESC` implica NULLS
// FIRST, então ordenar por uma coluna 100% NULL devolve linha ARBITRÁRIA como "melhor oferta".
// O plano tático sairia por cima de um ranking fabricado.

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

/**
 * Marcador de versão servido pela edge, ecoado tanto pela sonda (`{"probe":true}`) quanto pela
 * canária (`{"canary":true}`, no campo `contrato`). **Atualize a cada mudança relevante de
 * comportamento** — é ele que distingue um bundle novo de um velho em produção.
 *
 * `v1.0-afinidade-ordena` = o topBundle vem de `affinity_bundle` (com `.not(...is null)` e
 * `nullsFirst: false`), não de `lie_bundle`; `lie`/`margin` saíram do contexto do LLM. Ver
 * #1520 / 9f7e8962.
 *
 * ⚠️ O sensor só prova versões a partir de si mesmo: uma resposta de probe SEM o campo `versao` é
 * bundle pré-sensor — inclusive o próprio #1520 deployado antes deste PR.
 */
export const VERSAO = "v1.0-afinidade-ordena";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama a LLM da Anthropic e, no modo self-contained do cron, GRAVA o plano tático do cliente via service_role";
