import { supabase } from '@/integrations/supabase/client';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/**
 * Exclui um orçamento/rascunho — SEMPRE pela edge `excluir_pedido` (migration 20261120230001).
 *
 * O DELETE direto do cliente acabou (REVOKE DELETE): um orçamento que passou por um envio — mesmo
 * antes do claim existir — pode ter PV vivo no Omie com o write-back perdido. A edge consulta
 * `PV_<id>`, só apaga com ausência AFIRMADA e pela RPC condicionada ao claim do envio; com
 * `somente_orcamento`, também recusa se a linha deixou de ser orçamento (tela desatualizada).
 * Recusa ⇒ erro com o motivo da edge, nunca "Orçamento excluído".
 */
export async function excluirOrcamento(id: string): Promise<void> {
  const { error } = await supabase.functions.invoke('omie-vendas-sync', {
    body: { action: 'excluir_pedido', sales_order_id: id, omie_pedido_id: null, somente_orcamento: true },
  });
  if (error) {
    const motivo = (await mensagemDoErroEdge(error)) ?? mensagemDeErro(error) ?? 'falha ao excluir o orçamento';
    throw new Error(motivo);
  }
}
