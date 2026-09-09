// IDENTIDADE DE LINHA do item do pedido Omie — a régua ÚNICA de `det.ide.codigo_item`.
//
// POR QUE COMPARTILHADO: duas edges alimentam a MESMA coluna (`order_items.omie_codigo_item`) a
// partir do MESMO endpoint (`ListarPedidos`) — `sync-reprocess` (reconciliação) e
// `omie-vendas-sync` (nascimento do pedido). Régua duplicada é duas superfícies para divergir:
// bastaria uma delas ganhar um guard novo para a coluna passar a ter dois significados. É o mesmo
// argumento que fez o casamento de dois níveis nascer como UMA statement e não como IF/ELSE
// (docs/historico/identidade-de-linha-do-item.md).
//
// A RÉGUA: `Number.isSafeInteger` + `> 0`. Um `codigo_item` inválido (string vazia, 0, NaN de um
// shape inesperado) é PIOR que ausente — ausente degrada para o casamento por SKU, que é conhecido
// e guardado; um número fabricado casaria a linha ERRADA dentro do pedido, em silêncio, no caminho
// do dinheiro. Por isso a saída é `number | null`, nunca `0`.
export function normalizarCodigoItemOmie(bruto: unknown): number | null {
  const n = Number(bruto);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// G-a NO CLIENTE: identidade só vale para o pedido inteiro quando é DISTINTA entre as linhas que a
// trazem. Gravar `codigo_item` repetido em duas linhas do mesmo pedido é PIOR que gravar NULL: o
// `G-b` da `reconciliar_pedidos_omie` passa a PULAR aquele pedido para sempre (identidade repetida
// no ATUAL), e o pedido congela na revisão velha. Ausente é reversível; ambíguo gravado, não.
//
// A RPC repete este guard em SQL — de propósito. Este aqui existe para o payload nunca sair daqui
// ambíguo; o de lá existe porque a RPC é a fronteira que não pode confiar no chamador.
export function identidadeDistinta(codigos: Array<number | null>): boolean {
  const vistos = new Set<number>();
  for (const c of codigos) {
    if (c === null) continue;
    if (vistos.has(c)) return false;
    vistos.add(c);
  }
  return true;
}
