// Rejeição/cancelamento HUMANO de pedido sugerido — fronteira única: RPC `cancelar_pedido_sugerido`.
//
// Antes (M-02), o Cockpit (lote em useCicloHoje e inline em cicloHoje/PedidoRow) cancelava por
// UPDATE cru `.in("id", ids)` SEM guard de status: um pedido já DISPARADO (PO no portal/Omie)
// virava "cancelado" no banco com a compra em andamento — e sem a higiene do portal
// (`status_envio_portal`/`portal_proximo_retry_em`), que só a RPC faz. A RPC é a fronteira que
// TODA via cruza (money-path §5): guard de status no servidor (recusa `disparado`/
// `concluido_recebido`), carimbo de quem cancelou, limpeza do sub-fluxo do portal e vocabulário
// único (`cancelado_humano`, o mesmo do botão Cancelar da lista). Aqui só pré-filtramos
// (defense-in-depth) e traduzimos a resposta — precisão > recall: status fora da allowlist NÃO
// vai à RPC, e ausência de `status:"ok"` na resposta NÃO conta como rejeitado.
import { supabase as defaultClient } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/**
 * Status em que um humano ainda pode cancelar: nada foi enviado ao fornecedor. Mesma régua do
 * botão Cancelar da lista de pedidos (antes uma lista inline lá; agora fonte única).
 * `falha_envio` fica FORA de propósito: a tentativa de envio já aconteceu — conciliar antes.
 */
export const STATUS_CANCELAVEIS_PELO_HUMANO: ReadonlySet<string> = new Set([
  'pendente_aprovacao',
  'bloqueado_guardrail',
  'aprovado_aguardando_disparo',
]);

export function podeCancelarPeloHumano(status: string | null | undefined): boolean {
  return typeof status === 'string' && STATUS_CANCELAVEIS_PELO_HUMANO.has(status);
}

export interface PedidoRejeitavel {
  id: number;
  status: string | null | undefined;
}

export interface RejeitarOpts {
  usuario: string;
  justificativa: string;
}

export interface ResultadoRejeicao {
  rejeitados: number[];
  /** Nem foram à RPC: status fora da allowlist (ou desconhecido). */
  pulados: { id: number; motivo: string }[];
  /** A RPC recusou (guard do servidor) ou o transporte falhou. */
  falhas: { id: number; motivo: string }[];
}

// Cliente mínimo injetável (testabilidade). O default é o supabase real.
type RejeitarClient = Pick<typeof defaultClient, 'rpc'>;

// A RPC sinaliza regra de negócio devolvendo { error: '...' } no jsonb (não lança).
function erroDoJsonb(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error?: unknown }).error;
    if (e == null) return null;
    return typeof e === 'string' ? e : JSON.stringify(e);
  }
  return null;
}

function confirmouOk(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { status?: unknown }).status === 'ok';
}

/**
 * Rejeita (cancela) pedidos um a um pela RPC. Sequencial e best-effort: a falha de um não aborta
 * os demais; o resultado particiona o lote para o caller resumir com honestidade.
 */
export async function rejeitarPedidos(
  pedidos: readonly PedidoRejeitavel[],
  { usuario, justificativa }: RejeitarOpts,
  client: RejeitarClient = defaultClient,
): Promise<ResultadoRejeicao> {
  const r: ResultadoRejeicao = { rejeitados: [], pulados: [], falhas: [] };
  for (const p of pedidos) {
    if (!podeCancelarPeloHumano(p.status)) {
      r.pulados.push({ id: p.id, motivo: `status "${p.status ?? 'desconhecido'}" não pode ser rejeitado aqui` });
      continue;
    }
    try {
      const { data, error } = await client.rpc('cancelar_pedido_sugerido', {
        p_pedido_id: p.id,
        p_usuario: usuario,
        p_justificativa: justificativa,
      });
      if (error) {
        r.falhas.push({ id: p.id, motivo: mensagemDeErro(error) ?? 'erro sem mensagem' });
        continue;
      }
      const erro = erroDoJsonb(data);
      if (erro) {
        r.falhas.push({ id: p.id, motivo: erro });
        continue;
      }
      if (!confirmouOk(data)) {
        r.falhas.push({ id: p.id, motivo: 'resposta inesperada da RPC (sem status ok)' });
        continue;
      }
      r.rejeitados.push(p.id);
    } catch (e) {
      r.falhas.push({ id: p.id, motivo: mensagemDeErro(e) ?? 'erro sem mensagem' });
    }
  }
  return r;
}
