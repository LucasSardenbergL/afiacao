// Marcador de versão da edge `omie-sync-vendas-items`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// POR QUE ESTA EDGE GANHOU SONDA (2026-08-27): ela é o 5º dos 5 steps do `omie-cron-diario` e era
// INVERIFICÁVEL quanto a deploy — sem `versao.ts`, sem `{"probe":true}` e com um corpo de resposta
// byte-idêntico antes e depois de uma fatia. Verificar o #2031 (a coleira de RELÓGIO no `omieCall`
// dos 5 steps) travou nisso: só o step das NF-es recebidas, que já tinha sensor, se provou; os
// outros quatro ficaram como INFERÊNCIA. E o sintoma que a coleira corrige — request pendurado — é
// indistinguível de "o Omie estava lento" quando não se sabe qual bundle está no ar.
//
// Efeito desta edge: ela popula `venda_items_history` (1 linha por item de NF-e de venda com CFOP
// de venda), que é a SÉRIE DE DEMANDA lida pelo drill de alertas da reposição e pela ficha do SKU.
// É o denominador de "quanto sai por mês" — o número que decide o ponto de compra.
//
// ⚠️ SONDAR UM BUNDLE PRÉ-SENSOR AQUI É CARO. Esta edge não roteia por `action`: um corpo
// desconhecido cai nos defaults (`empresa:"OBEN"`, `dias:180`) e a varredura de ListarNF roda
// inteira — 180 dias é a janela mais larga dos cinco steps. Só sonde DEPOIS de confirmar o deploy
// — ou leia o marcador pelo caminho PASSIVO abaixo, que não custa chamada nenhuma.
//
// O CAMINHO PASSIVO é a metade que dispensa invocação: o `jsonRes` do `index.ts` anexa
// `versao: VERSAO` a TODA resposta, não só à da sonda. O `omie-cron-diario` faz `JSON.parse` do
// corpo de cada step e o devolve inteiro em `resultados.vendas.body`, então a resposta que o
// jobid 52 já grava em `net._http_response` a cada 2h carrega o marcador — prova de versão sem
// invocar nada (N3 PASSIVO da skill `lovable-deploy-verify`).
// ⚠️ Leia o `modo` ANTES do `versao`: em `modo:"background"` (o orquestrador aborta o cliente em
// 25s pelo `STEP_TIMEOUT_MS`) o corpo NÃO foi coletado e `versao` sai vazio — linha INUTILIZÁVEL,
// não "marcador velho".
//
// O gate desta edge é um `authorizeCronOrStaff` INLINE, e ele JÁ aceita `x-cron-secret`: a sonda
// entra logo APÓS ele, sem gate próprio.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync-vendas-items");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * O marcador NOMEIA a fatia em vez de dizer `v1.0-sensor-inicial`: o que entra aqui não é só o
 * sensor, é o sensor MAIS o eco passivo de `versao` em toda resposta — a metade que faz o deploy
 * se provar pelo tick do cron, sem ninguém chamar nada.
 */
export const VERSAO = "v1.0-eco-versao-passivo";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge reescreve venda_items_history — a série de demanda por SKU que o drill de alertas da " +
  "reposição e a ficha do SKU leem como 'quanto sai por mês', o denominador do ponto de compra — e " +
  "paga uma varredura de ListarNF no Omie sobre uma janela default de 180 dias, a mais larga dos " +
  "cinco steps do cron diário";
