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

/**
 * Follow-up do #4068 (Codex): o código de parcela do rascunho pode ter sido RETIRADO do Omie entre
 * gravar e restaurar. Reaplicá-lo às cegas bloqueava a sugestão do histórico (marca "manual") e o
 * envio seguia habilitado com um prazo que o ERP não tem mais. Confere contra a lista CARREGADA:
 *   - `aplicar`      → o código existe na lista; ou a lista está DEGRADADA (parcial) — aí o código
 *                      ausente já é barrado pelo bloqueio de `condicoesDoClienteIndisponiveis`.
 *   - `retirada`     → lista completa (não degradada) e o código não está nela.
 *   - `inconferivel` → a lista DESTA conta ainda não chegou (carregando/erro/vazia): a tela reaplica
 *                      (preserva a escolha manual) e confere de novo quando a lista chegar.
 */
export type DecisaoParcelaDoRascunho = 'aplicar' | 'retirada' | 'inconferivel';

export function decidirParcelaDoRascunho(
  codigo: string,
  lista: { formas: ReadonlyArray<{ codigo: string }>; degradado: boolean; carregada: boolean },
): DecisaoParcelaDoRascunho {
  if (!lista.carregada || lista.formas.length === 0) return 'inconferivel';
  if (lista.formas.some(f => f.codigo === codigo)) return 'aplicar';
  return lista.degradado ? 'aplicar' : 'retirada';
}

/**
 * Follow-up do #4068 (Codex P1): o código PROVADO retirado (lista completa sem ele) pode voltar pela
 * sugestão do histórico (`ultima_parcela`) — e a lista completa não o acusa, porque
 * `condicoesDoClienteIndisponiveis` só olha lista degradada. Enquanto ele estiver selecionado,
 * entra nas condições ausentes: o mesmo bloqueio fail-closed do botão E do caminho de envio.
 */
export function condicoesComParcelaRetirada(
  ausentes: ReadonlyArray<string>,
  retirada: string | null,
  selecionada: string,
): string[] {
  if (!retirada || retirada !== selecionada || ausentes.includes(retirada)) return [...ausentes];
  return [...ausentes, retirada];
}
