/**
 * Quando o preço de REFERÊNCIA de um cliente foi decidido por uuid — e por que a marca é do
 * cliente, não da linha.
 *
 * `compararRecencia` (`preco-referencia.ts`) ordena por instante → pedido → ordem de leitura →
 * posição. O primeiro critério é observado; o SEGUNDO é o `pedidoId`, um uuid v4. Quando dois
 * pedidos DISTINTOS empatam no instante — datas iguais, ou ambas ausentes — quem define o preço
 * de referência é o sorteio do uuid. E `razaoPreco = preçoDoCandidato / referência` é a chave
 * PRIMÁRIA da ordem do up-sell desde o #1837: a referência sorteada troca o vencedor.
 *
 * ⚠️ POR QUE POR CLIENTE, e não pela linha derivada. O motor guarda, por SKU, apenas a melhor
 * relação com uma base comprada — e a razão que decide essa "melhor" é justamente a que a
 * referência sorteada altera. O challenge executou o contraexemplo: base A com dois pedidos no
 * mesmo instante (preços 100 e 200) e base B inequívoca em 150; candidatos X=230 e Y=180. Com
 * referência 100, X e Y são ambos melhores via B e a linha marcada é DESCARTADA na dedup —
 * nenhuma flag sobrevive, e a RPC elegeria Y embora trocar só os uuids mude o topo. A marca
 * precisa sobreviver a elegibilidade, deduplicação e corte, e só o cliente vive mais que as três.
 *
 * ⚠️ POR QUE REDUZIR POR PEDIDO ANTES DE COMPARAR. Comparar cada item com a referência corrente,
 * par a par, erra dos DOIS lados (achado da rodada 4 do challenge):
 *
 *   ESCAPE  · o comparador também desempata DENTRO do mesmo pedido, pela posição. Dois pedidos P
 *             e Q no mesmo instante, P com preços [100, 200] e Q com [200, 100]: o primeiro item
 *             de Q tem o mesmo preço da referência corrente (não dispara), e o segundo muda o
 *             preço mas pertence ao MESMO pedido (não dispara). A referência final é 100 ou 200
 *             conforme o uuid, com a flag `false` nos dois mundos.
 *   EXCESSO · um empate HISTÓRICO ligaria a marca antes de aparecer um pedido estritamente mais
 *             recente e inequívoco, que torna o empate antigo irrelevante.
 *
 * Por isso: primeiro cada (cliente, SKU, pedido) é reduzido ao preço que a regra INTRA-pedido
 * escolhe — determinística, sem uuid —; depois só os pedidos empatados na recência MÁXIMA são
 * comparados entre si. Ambiguidade é dois pedidos distintos, no topo, com preços diferentes.
 */

/** Os pedidos que disputam o topo de um (cliente, SKU), já reduzidos a um preço cada. */
export interface TopoDeReferencia {
  /**
   * O instante máximo visto. `null` é o MENOS recente (o fail-closed de `compararRecencia`: sem
   * data não se afirma recência) — e um `null` só chega ao topo quando nenhum pedido tem data.
   */
  instante: number | null;
  /** pedidoId → o preço que a regra intra-pedido escolheu naquele pedido. */
  precosPorPedido: Map<string, number>;
}

export function topoVazio(): TopoDeReferencia {
  return { instante: null, precosPorPedido: new Map() };
}

/**
 * Registra um preço observado, mantendo só os pedidos que disputam a recência máxima.
 *
 * Dentro de um MESMO pedido a última ocorrência vence, porque o laço do motor percorre as
 * posições em ordem crescente e `compararRecencia` faz posição maior = mais recente. Isso é
 * determinístico e por isso NÃO é ambiguidade — reduzir o pedido a um preço antes de comparar é
 * o que separa "o uuid decidiu" de "a posição decidiu".
 */
export function registrarPrecoDoPedido(
  topo: TopoDeReferencia,
  instante: number | null,
  pedidoId: string,
  preco: number,
): void {
  const vazio = topo.precosPorPedido.size === 0;
  // `null` perde de qualquer data. Sem isto um pedido sem `created_at` competiria de igual para
  // igual com um datado, que é exatamente a afirmação que o fail-closed recusa fazer.
  const maisRecente =
    vazio ||
    (instante !== null && topo.instante === null) ||
    (instante !== null && topo.instante !== null && instante > topo.instante);
  const empata =
    !vazio && ((instante === null && topo.instante === null) || instante === topo.instante);

  if (maisRecente) {
    topo.instante = instante;
    topo.precosPorPedido.clear();
    topo.precosPorPedido.set(pedidoId, preco);
    return;
  }
  if (empata) topo.precosPorPedido.set(pedidoId, preco);
  // Mais antigo: descartado. Um empate histórico não torna a referência atual arbitrária.
}

/**
 * A referência deste (cliente, SKU) foi decidida por uuid?
 *
 * Exige DOIS pedidos distintos no topo E preços diferentes entre eles. Dois pedidos empatados com
 * o MESMO preço não geram ambiguidade: o uuid escolhe qual, e o valor resultante é o mesmo — não
 * há decisão a contaminar.
 */
export function referenciaEhAmbigua(topo: TopoDeReferencia): boolean {
  if (topo.precosPorPedido.size < 2) return false;
  return new Set(topo.precosPorPedido.values()).size >= 2;
}
