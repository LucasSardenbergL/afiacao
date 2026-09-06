// Remoção de itens de pedido sugerido — fronteira única: RPC `remover_itens_pedido_sugerido`.
//
// Antes, as TRÊS vias do modal de detalhes (remover item, remover em lote, descontinuar SKU)
// faziam `DELETE FROM pedido_compra_item` cru e, quando o pedido ficava sem itens, gravavam por
// `UPDATE` cru `status='cancelado_humano'` + carimbos + higiene do portal — espelhando à mão o que
// a RPC `cancelar_pedido_sugerido` faz, mas FORA dela (a "fronteira única" do #2204 não cobria
// esta via). Nenhuma das duas escritas tinha guard de status no servidor: o único freio era
// `podeEditar` no CLIENTE, decidido sobre o `pedido.status` que o browser tem em mãos, que pode
// estar minutos desatualizado. É literalmente o [P1] do parecer Codex do #2204 — "a allowlist não
// é política de servidor; ela valida apenas o status potencialmente obsoleto vindo do browser".
//
// O dano: modal aberto com o pedido `pendente_aprovacao` → o pedido é aprovado e disparado
// enquanto o modal fica aberto → o operador remove o último item → o UPDATE cru carimba
// `cancelado_humano` sobre uma COMPRA REAL já criada no Omie. E o DELETE, que roda ANTES, já
// tinha apagado itens de um pedido que o fornecedor tem.
//
// A RPC é a fronteira que toda via cruza: trava a linha do pedido (`FOR NO KEY UPDATE`) ANTES de
// qualquer escrita, relê o status REAL sob esse lock, aplica a ALLOWLIST
// (`pendente_aprovacao`/`bloqueado_guardrail` — a mesma regra do `podeEditar`, agora no servidor) e
// só então apaga, recalcula `valor_total`/`num_skus` A PARTIR DO BANCO e cancela se esvaziou —
// tudo numa transação. Ver `supabase/migrations/20260906105549_remover_itens_pedido_guard.sql`.
//
// ⚠️ Precisão > recall: a recusa da RPC vira ERRO VISÍVEL (throw → toast de erro na mutation), e
// NUNCA sucesso silencioso. Uma resposta sem `status: "ok"` também não conta como removida.
import { supabase as defaultClient } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/**
 * Estados em que o servidor aceita remoção de item. Espelha `podeEditar` do modal — mas quem
 * decide é a RPC; esta constante existe para a UI e para o teste que casa as duas pontas.
 * `aprovado_aguardando_disparo` fica FORA de propósito: é o estado que a edge
 * `disparar-pedidos-aprovados` seleciona para chamar o Omie, e ela LÊ os itens para montar o
 * pedido de compra — remover ali é alterar a compra durante o envio.
 */
export const STATUS_COM_ITENS_EDITAVEIS: ReadonlySet<string> = new Set([
  'pendente_aprovacao',
  'bloqueado_guardrail',
]);

export interface ResultadoRemocao {
  pedidoId: number;
  /** Quantos itens a RPC realmente apagou (pode ser < pedidos: id inexistente ou de outro pedido). */
  removidos: number;
  /** Itens que sobraram no pedido, contados NO BANCO depois do DELETE. */
  restantes: number;
  valorTotal: number;
  /** true quando o pedido esvaziou e a RPC o cancelou (`cancelado_humano`) na mesma transação. */
  cancelado: boolean;
}

type RemoverClient = Pick<typeof defaultClient, 'rpc'>;

function erroDoJsonb(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error: unknown }).error;
    // `String(e)` e não `e as string`: a RPC devolve texto, mas um `{"error": null}` (o colapso de
    // `'texto' || NULL`) não pode virar "sem erro" — vira uma mensagem genérica, e a recusa
    // continua VISÍVEL. Mesma lição da 20260905224959.
    return typeof e === 'string' && e.length > 0 ? e : 'a remoção foi recusada pelo servidor';
  }
  return null;
}

function numero(data: unknown, chave: string): number {
  const v = (data as Record<string, unknown>)?.[chave];
  return typeof v === 'number' ? v : 0;
}

/**
 * Remove itens de UM pedido pela fronteira. Lança em qualquer desfecho que não seja sucesso
 * confirmado — o chamador (mutation) transforma isso em toast de erro.
 */
export async function removerItensDoPedido(
  pedidoId: number,
  itemIds: readonly number[],
  usuario: string,
  client: RemoverClient = defaultClient,
): Promise<ResultadoRemocao> {
  const { data, error } = await client.rpc('remover_itens_pedido_sugerido', {
    p_pedido_id: pedidoId,
    p_item_ids: [...itemIds],
    p_usuario: usuario,
  });
  if (error) throw new Error(mensagemDeErro(error) ?? 'erro sem mensagem');

  const recusa = erroDoJsonb(data);
  if (recusa) throw new Error(recusa);

  if (!data || typeof data !== 'object' || (data as { status?: unknown }).status !== 'ok') {
    throw new Error('resposta inesperada da RPC (sem status ok)');
  }

  return {
    pedidoId,
    removidos: numero(data, 'removidos'),
    restantes: numero(data, 'restantes'),
    valorTotal: numero(data, 'valor_total'),
    cancelado: (data as { cancelado?: unknown }).cancelado === true,
  };
}
