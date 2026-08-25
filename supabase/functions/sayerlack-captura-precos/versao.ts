// Marcador de versão da edge `sayerlack-captura-precos`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: ela abre sessão autenticada no portal do FORNECEDOR (Sayerlack) via
// Browserless e, para cada SKU, monta uma linha no pedido — é assim que o preço aparece — e
// cancela a linha em seguida. O custo de rodar por engano não é banco nosso: é um terceiro vendo
// atividade na conta, e um aborto no meio (budget estourado, timeout do portal) deixando linhas
// em rascunho que o operador humano confunde com pedido próprio (o código já trata esse caso em
// `classificarLinhasRascunho`, o que confirma que ele acontece). Consome quota Browserless e
// grava preço, que é money-path: alimenta a troca QT→GL do motor de embalagem econômica.
//
// ⚠️ O cabeçalho do index.ts promete que "não existe caminho de código que finalize/grave pedido
// no portal" — e diferente das duas armadilhas conhecidas (`dry_run` do disparar-pedidos-aprovados,
// modo `ECO` do enviar-pedido-portal-sayerlack), esta promessa É verificada: o teste-invariante
// `src/lib/reposicao/__tests__/embalagem-captura-edge-invariants.test.ts` quebra o CI se um token
// de finalização aparecer no arquivo. Promessa com fiador, não comentário solto.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sayerlack-captura-precos");

/**
 * Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho.
 *
 * `v1.1-pos-login-na-captura` (8ee8afa15): o pós-login deixou de inferir sucesso de `url_changed` e passou a
 * classificar por SINAIS do DOM (menu do sidebar e campos de senha), via `_shared/sayerlack-pos-login.ts`. Antes, troca de
 * senha exigida pelo portal virava exceção — o `url_changed` mudava e lia como dashboard.
 *
 * ⚠️ Este bump é TARDIO: o 8ee8afa15 mergeou em 2026-08-21 e o marcador ficou em
 * `v1.0-sensor-inicial`, então a sonda não discriminava aquele deploy. Ele NÃO recupera a
 * discriminação perdida — reata só o sentido positivo, do próximo deploy em diante
 * (`docs/historico/sonda-marcador-congelado.md`).
 */
export const VERSAO = "v1.1-pos-login-na-captura";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack e monta linhas de pedido para ler " +
  "preço; um aborto no meio deixa rascunho que o operador humano confunde com pedido próprio, " +
  "e a corrida queima quota Browserless";
