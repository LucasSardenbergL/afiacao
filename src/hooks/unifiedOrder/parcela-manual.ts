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

/**
 * B7 (rodada 2): o rascunho guarda SÓ o prazo escolhido à mão nesta seleção (por conta). Prazo que
 * veio do histórico não vai — ao restaurar, o histórico é reaplicado normalmente. Sem isso, o
 * cenário "escolhe prazo → ATP bloqueia → refresh → restaura" saía com a `ultima_parcela`.
 */
export interface ParcelasDoRascunho {
  oben: string | null;
  colacor: string | null;
}

export function parcelasManuaisParaRascunho(
  marca: MarcaParcelaManual,
  tokenDaSelecao: number,
  selecionadas: { oben: string; colacor: string },
): ParcelasDoRascunho {
  return {
    oben: marca.oben === tokenDaSelecao && selecionadas.oben ? selecionadas.oben : null,
    colacor: marca.colacor === tokenDaSelecao && selecionadas.colacor ? selecionadas.colacor : null,
  };
}

/** Lê o campo do rascunho em disco (pode ser de versão antiga, sem o campo, ou adulterado). */
export function lerParcelasDoRascunho(v: unknown): ParcelasDoRascunho | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const oben = typeof o.oben === 'string' && o.oben ? o.oben : null;
  const colacor = typeof o.colacor === 'string' && o.colacor ? o.colacor : null;
  return oben || colacor ? { oben, colacor } : null;
}
