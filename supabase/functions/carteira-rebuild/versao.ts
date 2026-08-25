// Marcador de versão da edge `carteira-rebuild`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE GANHOU SONDA (auditoria das canárias, 2026-08-25) — ela era o caso MAIS
// desprotegido do repo, e por uma combinação que nenhum gate alcançava:
//
//   • NÃO tinha `versao.ts` ⇒ ficava fora do `sonda:bump` (#1993) e do `sonda:fingerprint` (#1998),
//     que só varrem edge instrumentada;
//   • não importa `_shared/paginate.ts` ⇒ o gate "nenhuma edge que serve o paginate.ts fica SEM
//     prova de deploy" a pula — e ele se declara piso, então não é furo dele;
//   • não está em `VERIFICAVEL_POR_CANARIA` ⇒ nada registrava a canária como prova de deploy.
//
// Resultado: a ÚNICA prova de deploy era o `contrato` da canária (`trava-saida-v1`), congelado
// desde 2026-07-20 (56f9f58b3) — enquanto em 2026-07-28 entrou uma correção de paginação REAL
// (f6561b0b2, "13 sites onde falha vira fim") e em 2026-08-08 a consolidação do especificador
// (5f5523df9). Nenhuma das duas moveu o marcador.
//
// ⚠️ E a de paginação é justamente a classe que NENHUMA fixture discrimina: enquanto o `max-rows`
// de prod for 1000 ela é no-op por DESENHO (`docs/historico/deploy-no-op-por-desenho.md`). Ou seja,
// aquele deploy era INVERIFICÁVEL — a canária responde `trava-saida-v1` com o bundle de julho ou o
// de agosto, e não existia fixture capaz de separá-los. É o buraco que este marcador fecha.
//
// A CANÁRIA NÃO É SUBSTITUÍDA — as duas provam coisas diferentes, e é essa divisão que torna as
// outras 5 canárias do repo saudáveis: o `contrato` (`trava-saida-v1`) nomeia a fatia que a FIXTURE
// verifica (trava de saída do bootstrap, P0-B-bis) e pode ficar estável de forma legítima; o
// `VERSAO` prova QUAL BUNDLE está no ar, e tem de mudar a cada fatia. Antes desta entrega a canária
// acumulava os dois papéis e falhava no segundo.
//
// ⚠️ SONDAR UM BUNDLE PRÉ-SENSOR AQUI É CARO — ao contrário da `omie-analytics-sync`, onde um corpo
// sem `action` conhecida cai no `default` com 400 sem tocar nada. Esta edge não roteia por `action`:
// um bundle que não conhece `probe` IGNORA o campo e segue para o fluxo real, que é o rebuild
// completo (lease + ~6909 upserts). É a mesma armadilha que o comentário da canária já registra
// para o `?canary=1`. Consequência operacional: resposta SEM o eco `probe:true` significa que a
// sonda não rodou E o rebuild rodou — o veredito vem junto com o efeito, não no lugar dele.
//
// O gate desta edge é o `authorizeCronOrStaff` de `_shared/auth.ts`, que JÁ aceita `x-cron-secret`:
// a sonda entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("carteira-rebuild");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * `v1.0-sensor-inicial` é HONESTO aqui: o sensor de VERSÃO nasce nesta fatia. A canária
 * pré-existente não muda isso — ela é sensor de COMPORTAMENTO, e a regra 1 de `deploy.md`
 * ("`v1.0-sensor-inicial` só é honesto quando o sensor NASCE ali") fala do marcador que está
 * nascendo, não de haver outro sensor na edge. Mesmo precedente da `omie-analytics-sync`, que
 * também tinha canária (`doc_ambiguo_probe`) quando ganhou a sonda.
 */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reconstrói a CARTEIRA inteira: toma o lease e reescreve ~6909 assignments de " +
  "cliente↔vendedor (upsert idempotente, mas o ciclo completo), e é esse mapa que decide quem " +
  "aparece na carteira de cada vendedor e quem cobra comissão — assignment stale é vendedor errado " +
  "elegível cobrando; um disparo acidental também DISPUTA o lease com o rebuild legítimo do cron";
