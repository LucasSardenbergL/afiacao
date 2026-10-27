/**
 * Situação dos ITENS de uma NF-e de entrada no app — o que a tela pode afirmar sobre eles.
 *
 * Até a importação transacional (`importar_nfe_recebimento`, out/2026) o cabeçalho entrava sem os
 * itens. 52 NF-e (abr–out/2026) foram recebidas direto no Omie e o `omie-nfe-reconcile` as marcou
 * `efetivado`: estoque e CMC estão no Omie, mas o app não tem item nem lote delas. Decisão do
 * founder (plano v3, item 4): rótulo "Recebida fora do app", SEM backfill.
 *
 * Ausente ≠ zero: NF-e sem item no app nunca vira "0 itens" nem "0 de 0 unidades" — isso afirma
 * uma nota vazia, e a nota tem mercadoria.
 */

export type SituacaoItensNf = 'com_itens' | 'recebida_fora_do_app' | 'itens_nao_carregados';

export const ROTULO_RECEBIDA_FORA_DO_APP = 'Recebida fora do app';

export const EXPLICACAO_RECEBIDA_FORA_DO_APP =
  'A entrada desta NF-e foi feita direto no Omie, sem conferência no app. O estoque e o custo estão no Omie; os itens e os lotes não foram registrados aqui.';

export const ROTULO_ITENS_NAO_CARREGADOS = 'Itens não carregados';

export function situacaoItensNf(
  status: string | null | undefined,
  itens: readonly unknown[] | null | undefined,
): SituacaoItensNf {
  if (itens && itens.length > 0) return 'com_itens';
  return status === 'efetivado' ? 'recebida_fora_do_app' : 'itens_nao_carregados';
}
