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

export { classificarSonda, erroSondaAmbigua, respostaSonda } from "../_shared/sonda-versao.ts";

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge abre sessão no portal do FORNECEDOR Sayerlack e monta linhas de pedido para ler " +
  "preço; um aborto no meio deixa rascunho que o operador humano confunde com pedido próprio, " +
  "e a corrida queima quota Browserless";
