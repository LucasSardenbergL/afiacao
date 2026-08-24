// Marcador de versão da edge `tactical-plans-batch`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Oitava leva (#1889/#1901, paginação): uma das 7 edges dependentes do `_shared/paginate.ts` sem
// sensor nenhum. No-op por DESENHO ⇒ só o marcador prova o deploy
// (`docs/historico/deploy-no-op-por-desenho.md`).
//
// CUSTO DO BUNDLE VELHO IGNORANDO `probe`: ALTO, e o único das sete que gasta TOKEN DE MODELO. Ela
// não lê o corpo em versão anterior a esta, e o gate (`authorizeCron`) aceita exatamente o
// `x-cron-secret` do SQL Editor: a sonda às cegas varre as carteiras e dispara
// `generate-tactical-plan` por cliente elegível, uma chamada de LLM cada. Confirme o deploy por
// outro meio antes de sondar.
//
// A edge que ela dispara — `generate-tactical-plan` — tem sonda desde o #1618 e marcador desde o
// #1754; esta é a metade do par que faltava, e as duas foram bumpadas/instrumentadas na MESMA
// fatia de propósito: verificar só a de baixo deixaria o batch inverificável, que é como o par
// chegou até aqui.
//
// A sonda vem DEPOIS do gate (comparação de env pura com cron-secret) e ANTES do `createClient`.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("tactical-plans-batch");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge varre TODAS as carteiras e dispara generate-tactical-plan por cliente elegível — cada " +
  "disparo é uma chamada de LLM que grava o plano tático do cliente; um run não pedido gasta token " +
  "por cliente da base e sobrescreve o plano do dia que o vendedor já pode ter aberto";
