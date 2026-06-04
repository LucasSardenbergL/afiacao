// Lógica pura da edição de custo de primeira compra no DetalhesModal.
// Permite definir o preço de itens SEM custo (preco_unitario <= 0) direto na tela,
// substituindo o flip de status + UPDATE no SQL Editor. Money-path: nunca grava
// preço <= 0 (o disparo rejeita nValUnit=0 no Omie).
import type { PedidoItem, Status } from './types';

// Estados em que o custo de um item de primeira compra (preço 0) pode ser definido
// na tela:
// - pendente_aprovacao / bloqueado_guardrail: definir ANTES de aprovar (previne a falha).
// - falha_envio: recuperar o pedido que já falhou por "SKU(s) sem custo (preço 0)".
// Fora desses (disparado, aprovado_aguardando_disparo, cancelado): read-only.
const ESTADOS_EDITA_PRECO: ReadonlySet<string> = new Set([
  'pendente_aprovacao',
  'bloqueado_guardrail',
  'falha_envio',
]);

export function podeEditarPrecoPedido(status: Status | null | undefined): boolean {
  return !!status && ESTADOS_EDITA_PRECO.has(status);
}

// Um item só ganha input de preço quando o pedido permite E o item está sem custo
// (preço <= 0) — exatamente o que trava o disparo. Item com custo válido fica
// read-only (não arriscar fat-finger num preço bom que já veio do motor/recebimento).
export function precoEditavelDaLinha(
  podeEditarPreco: boolean,
  item: Pick<PedidoItem, 'preco_unitario'>,
): boolean {
  return podeEditarPreco && !(Number(item.preco_unitario ?? 0) > 0);
}

// Valida um valor de preço digitado antes de gravar: finito e > 0.
export function precoEditValido(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

export interface ItemUpdate {
  qtde_final: number;
  valor_linha: number;
  ajustado_humano: true;
  // Só presente quando o usuário editou o preço — NUNCA reescrito a partir de um
  // ajuste só-de-quantidade (senão um quantity-only edit poderia zerar um preço
  // válido quando o item está fora do cache). Codex review [P1].
  preco_unitario?: number;
}

// Monta o patch de um item editado a partir dos ajustes de quantidade (`qtdEdit`)
// e de preço (`precoEdit`, undefined = sem edição de preço). Money-path: só inclui
// `preco_unitario` quando houve edição de preço; quantidade-só preserva o preço atual.
export function montarUpdateItem(
  item: Pick<PedidoItem, 'qtde_final' | 'qtde_sugerida' | 'preco_unitario'>,
  qtdEdit: number | undefined,
  precoEdit: number | undefined,
): ItemUpdate {
  const temPrecoEdit = precoEdit !== undefined;
  const qtd = qtdEdit ?? Number(item.qtde_final ?? item.qtde_sugerida ?? 0);
  const preco = temPrecoEdit ? (precoEdit as number) : Number(item.preco_unitario ?? 0);
  const update: ItemUpdate = {
    qtde_final: qtd,
    valor_linha: qtd * preco,
    ajustado_humano: true,
  };
  if (temPrecoEdit) update.preco_unitario = preco;
  return update;
}
