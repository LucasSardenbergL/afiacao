/**
 * A7 (rodada 2): prazo escolhido à mão NÃO pode ser sobrescrito pela sugestão do histórico.
 *
 * A `ultima_parcela` do cliente chega DEPOIS da seleção (lookup no Omie); se a vendedora já
 * escolheu o prazo nesse meio-tempo (combobox ou "aplicar sugestão" do aviso de prazo), aplicar
 * o histórico trocava o prazo em silêncio — e o pedido ia com prazo diferente do combinado.
 *
 * A marca guarda o TOKEN da seleção em que a escolha manual aconteceu (por conta): trocar ou
 * limpar o cliente incrementa o token, então a marca de outro cliente nunca vale aqui.
 */
export interface MarcaParcelaManual {
  oben: number | null;
  colacor: number | null;
}

export function marcaParcelaManualVazia(): MarcaParcelaManual {
  return { oben: null, colacor: null };
}

/** A sugestão do histórico só entra se a conta NÃO foi escolhida à mão NESTA seleção. */
export function podeSugerirParcela(marcaDaConta: number | null, tokenDaSelecao: number): boolean {
  return marcaDaConta !== tokenDaSelecao;
}
