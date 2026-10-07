// Marcador de versão da edge `omie-sync-estoque`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela REESCREVE o saldo que o motor de reposição consome — upsert em
// `sku_estoque_atual` e `sku_status_omie`, linhas em `eventos_outlier`, e avanço do marcador de
// frescor em `sync_state` (`gravarMarcadorSentinela`). `sku_parametros` ela só LÊ.
//
// Por que a sonda importa aqui: o custo não é "gastar uma chamada", é que um run parcial do Omie
// vira saldo "atual" com cara de bom. O saldo alimenta sugestão de compra; e o marcador avançado
// diz ao Sentinela que o dado está fresco — ou seja, o run ruim também apaga o sinal de que
// ele foi ruim. Trocar em três palavras: aqui a falha é SILENCIOSA por desenho do frescor.
//
// O gate desta edge é `authorizeCronOrStaff` (`_shared/auth.ts`), que JÁ aceita `x-cron-secret`:
// a sonda entra logo APÓS ele, sem gate próprio — diferente das edges de NF-e (#1753/#1766).

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sync-estoque");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
/**
 * BUMP (coleira de relógio, sequela do #2018/#2025/#2031): os dois wrappers (`callOmie` e
 * `callOmiePedidos`) passaram a levar `AbortSignal.timeout` com deadline compartilhado do run,
 * derivado do teto de 90s dos crons 31/124. O caso que mais pesa aqui é o sono de 60s no 429 —
 * dois terços do orçamento inteiro num único rate-limit.
 *
 * Sem bump, a sonda responderia a MESMA string tendo esta fatia subido ou não; e como esta edge
 * NÃO escreve em `fin_sync_log`, a sonda é a única prova de qual bundle está no ar.
 */
/**
 * BUMP v1.2 (follow-up Codex do #2549): `fetchEmTransitoKeys` passou a incluir 'disparado_simulado'
 * (o dry_run da disparar-pedidos-aprovados cria PO REAL no Omie), junto com a mesma mudança na CTE
 * em_transito de `gerar_pedidos_sugeridos_ciclo` (migration 20260925225004). As duas listas são UMA
 * fonte: status que a RPC conta e este sync não exclui do pendente vira dupla contagem.
 */
/**
 * BUMP v1.4 (PR0 da baixa de PO, spec 2026-09-26 §15 item 2): a varredura do "a caminho" ANOTA o conjunto
 * aberto que o motor contou (coletor de `observacao-po.ts`, 1 registro por PO) e o handler o publica em
 * `reposicao_po_observado_run/_item` (RPC `reposicao_po_observado_publicar`, migration 20261005131331) —
 * DEPOIS do upsert do pendente, só se a soma das contribuições bater com o pendente calculado, e nunca fatal.
 * O cálculo do pendente não muda; a resposta ganha `observacao_publicada`/`observacao_motivo`.
 */
/**
 * BUMP v1.5 (incidente 2026-10-05 17:40Z, net._http_response 104687 — deadline na fase do PO descartou o físico já
 * lido): (1) deadline do run 75→80s, com a folga da observação 10→5s (mesmo corte absoluto de 85s); (2) cada run
 * grava 1 linha em `acoes_execucoes` (slug `reposicao.sync_estoque`) com o relógio por fase — sucesso ou erro —, e
 * cada escrita do registro tem prazo de 2s (`registro-com-prazo.ts`). A fase do PO segue em série, DEPOIS do físico:
 * a versão em paralelo foi revertida no adversarial do PR (o PO lido antes conta duas vezes a NF recebida no meio do
 * run, e o motor sub-sugere).
 */
/**
 * BUMP v1.6 (os três achados preexistentes do adversarial do #2817 — caminhos em que a edge respondia ok:true sobre um
 * par (físico, pendente) que o motor não deveria consumir; desenho com o Codex em 2026-10-06): (1) físico incompleto
 * (truncado, sobre-lido, total ausente/variando, par produto|local repetido, nenhum habilitado) → recusa ANTES da fase
 * do PO (`fisico.ts`); (2) pendente não confiável → recusa ANTES de qualquer escrita, o par velho fica coerente (a v1.5
 * gravava o físico fresco com o pendente velho: dupla contagem invisível); (3) gravação parcial → marcadores 'partial'
 * e ok:false, com prazo na cauda e a inativação no desfecho. A orquestração mudou para `publicacao.ts`.
 */
export const VERSAO = "v1.6-recusa-par-torto";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge REESCREVE o saldo de estoque que o motor de reposição consome (upsert em " +
  "sku_estoque_atual e sku_status_omie, eventos_outlier) e AVANÇA o marcador de frescor em " +
  "sync_state — um run parcial do Omie vira saldo 'atual' e ainda apaga o sinal de que foi parcial";
