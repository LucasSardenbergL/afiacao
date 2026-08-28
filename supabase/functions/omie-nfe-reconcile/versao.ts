// Marcador de versão da edge `omie-nfe-reconcile`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE GANHOU SONDA (medido em 2026-08-26, ao verificar o #2025) — ela é o caso em que
// a escada de `lovable-deploy-verify` travou no N1 com TODOS os degraus seguintes fechados:
//
//   • N2 (Management API) é estruturalmente indisponível — o Supabase é da org do Lovable
//     (`docs/historico/verificar-sonda-versao.md` §6). Não é dívida desta edge; é do projeto.
//   • O rastro do bot `gpt-engineer-app[bot]` prova que UM deploy rodou, não QUAL versão subiu.
//   • N3 era IMPOSSÍVEL, e é aqui que esta edge é diferente das outras 34: ela JÁ respondia um
//     campo `versao` — e ele não serve.
//
// ⚠️ A ARMADILHA ESPECÍFICA DESTA EDGE: um campo `versao` na resposta do FLUXO REAL é o disfarce
// mais perigoso que existe para a verificação de deploy. `index.ts:572` e `:638` emitem
// `versao: "v3.3-paginacao-janelas"` — string HARDCODED, acesa à mão, que o #2025 (coleira de
// relógio no `omieCall`, `7e076f1f7`) NÃO alterou. Ou seja: idêntica byte a byte no bundle velho e
// no novo, e o diff do #2025 tampouco acrescentou qualquer campo à resposta. Quem sondasse leria
// `versao: v3.3-paginacao-janelas`, concluiria "verificado" — e teria verificado NADA.
//
// É a mesma classe de `docs/historico/canaria-papel-duplo.md` com uma volta a mais: lá o marcador
// de papel duplo estava na CANÁRIA (caminho barato, aceso à mão); aqui ele está na resposta do
// FLUXO REAL, que custa a varredura inteira. O marcador de fatia não vira sensor de bundle só por
// se chamar `versao`.
//
// O `v3.3-paginacao-janelas` NÃO É SUBSTITUÍDO — ele tem um papel legítimo e EM USO: é a assinatura
// que identificou o emissor das linhas de `net._http_response` na investigação de teto de cron
// (`docs/historico/cron-teto-volume-vs-latencia.md` §Veredito 2, jobid 162). Trocá-lo cegaria uma
// verificação que funciona. Mesma divisão de papéis do #2009/#2026: o marcador antigo nomeia a
// FATIA, o `VERSAO` prova QUAL BUNDLE respondeu — e o `fonte` (fingerprint da fonte, servido por
// `criarRespostaSonda`) prova deploy VERBATIM sem depender de ninguém lembrar de bumpar nada (#2018).
//
// ⚠️ SONDAR UM BUNDLE PRÉ-SENSOR AQUI É CARO — mesma situação da `carteira-rebuild`, não a da
// `omie-analytics-sync`. Esta edge não roteia por `action`: o parse do corpo vive num `try/catch`
// cujo `catch` cai no default do cron (`{ limite: 25 }`), então um bundle que não conhece `probe`
// IGNORA o campo e roda a varredura completa. Consequência operacional: resposta SEM o eco
// `probe:true` significa que a sonda não rodou E a varredura rodou — o veredito vem junto com o
// efeito, não no lugar dele (`docs/agent/deploy.md` §Canárias, armadilha 1).
//
// O gate desta edge é o `authorizeCronOrStaff` de `_shared/auth.ts`, que JÁ aceita `x-cron-secret`:
// a sonda entra logo APÓS ele e ANTES do `createClient`, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-nfe-reconcile");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * `v1.0-sensor-inicial` é HONESTO aqui: o sensor de VERSÃO nasce nesta fatia. O
 * `v3.3-paginacao-janelas` da resposta do fluxo real não é contraexemplo — ele é marcador de FATIA
 * (e o cabeçalho acima explica por que não serve como sensor de bundle), exatamente como o
 * `contrato` de uma canária não impediu a `carteira-rebuild` e a `omie-vendas-sync` de nascerem em
 * `v1.0-sensor-inicial`.
 */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge BAIXA conferência de recebimento sem humano nenhum: marca `nfe_recebimentos` como " +
  "`efetivado` (com `alterar_recebimento_ok`/`alterar_etapa_ok`/`concluir_recebimento_ok` = true) e " +
  "grava o ledger `nfe_efetivacao_tentativas` — a NF sai do painel de pendências, que é o único " +
  "lugar onde alguém ainda a veria, e o caminho de volta é manual; e ANTES disso a varredura gasta " +
  "até 12 chamadas `ListarRecebimentos` na API do Omie, método que tem trava anti-redundância POR " +
  "CONTA (params distintos a 4s já voltaram REDUNDANT), então um disparo acidental também envenena " +
  "a rodada legítima do cron `omie-nfe-reconcile-1h`, que volta sem reconciliar nada";
