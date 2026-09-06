// Rejeição/cancelamento HUMANO de pedido sugerido — fronteira única: RPC `cancelar_pedido_sugerido`.
//
// Antes (M-02), o Cockpit (lote em useCicloHoje e inline em cicloHoje/PedidoRow) cancelava por
// UPDATE cru `.in("id", ids)` SEM guard de status: um pedido já DISPARADO (PO no portal/Omie)
// virava "cancelado" no banco com a compra em andamento — e sem a higiene do portal
// (`status_envio_portal`/`portal_proximo_retry_em`), que só a RPC faz. A RPC é a fronteira que
// TODA via cruza (money-path §5): guard de status no servidor (recusa `disparado`/
// `concluido_recebido`), carimbo de quem cancelou, limpeza do sub-fluxo do portal e vocabulário
// único (`cancelado_humano`, o mesmo do botão Cancelar da lista).
//
// Aqui: (1) o status é RELIDO do banco imediatamente antes de decidir — o que o browser mostra pode
// ter minutos (Codex P1: `falha_envio` depois de uma tentativa de envio NÃO pode ser cancelado por
// quem ainda vê "aprovado"); (2) a allowlist depende da VIA: em lote só o que nunca foi aprovado; o
// veto de um auto-aprovado (`aprovado_aguardando_disparo`) é ação individual; (3) precisão > recall:
// fora da allowlist NÃO vai à RPC, e ausência de `status:"ok"` na resposta NÃO conta como rejeitado.
//
// ⚠️ A RPC em si lê o status e faz `UPDATE … WHERE id` sem repetir o predicado (TOCTOU com o
// disparador) — fechar isso é migration (`WHERE id AND status NOT IN (…) RETURNING`), pendência do
// founder registrada no PR; este helper reduz a janela, não a elimina.
import { supabase as defaultClient } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/** Nunca aprovado: nada foi enviado ao fornecedor. É o que o LOTE pode rejeitar. */
export const STATUS_CANCELAVEIS_EM_LOTE: ReadonlySet<string> = new Set(['pendente_aprovacao', 'bloqueado_guardrail']);

/**
 * Cancelável por um humano numa ação INDIVIDUAL (linha do ciclo, botão Cancelar da lista): inclui o
 * veto de um auto-aprovado que ainda aguarda o cron. `falha_envio` fica FORA de propósito: a
 * tentativa de envio já aconteceu — conciliar antes de cancelar.
 */
export const STATUS_CANCELAVEIS_PELO_HUMANO: ReadonlySet<string> = new Set([
  ...STATUS_CANCELAVEIS_EM_LOTE,
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
  /** Via da ação: `lote` usa a allowlist estreita; `individual` inclui o veto do auto-aprovado. */
  via: 'lote' | 'individual';
}

export interface ResultadoRejeicao {
  rejeitados: number[];
  /** Nem foram à RPC: status ATUAL (relido do banco) fora da allowlist, ou pedido que sumiu. */
  pulados: { id: number; status: string | null; motivo: string }[];
  /** A RPC recusou (guard do servidor) ou o transporte falhou. */
  falhas: { id: number; motivo: string }[];
}

// Cliente mínimo injetável (testabilidade). O default é o supabase real.
type RejeitarClient = Pick<typeof defaultClient, 'rpc' | 'from'>;

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

/** Status ATUAL dos pedidos, relido do banco (o do browser pode ter minutos). Lança em erro de leitura. */
async function statusAtual(ids: number[], client: RejeitarClient): Promise<Map<number, string | null>> {
  const { data, error } = await client.from('pedido_compra_sugerido').select('id, status').in('id', ids);
  if (error) throw error;
  return new Map(((data ?? []) as { id: number; status: string | null }[]).map((r) => [r.id, r.status]));
}

/**
 * Rejeita (cancela) pedidos um a um pela RPC, decidindo pelo status RELIDO do banco. Sequencial e
 * best-effort: a falha de um não aborta os demais; o resultado particiona o lote para o caller
 * resumir com honestidade. Se nem o status der para ler, ninguém é rejeitado (fail-closed).
 */
export async function rejeitarPedidos(
  pedidos: readonly PedidoRejeitavel[],
  { usuario, justificativa, via }: RejeitarOpts,
  client: RejeitarClient = defaultClient,
): Promise<ResultadoRejeicao> {
  const r: ResultadoRejeicao = { rejeitados: [], pulados: [], falhas: [] };
  if (pedidos.length === 0) return r;
  const permitidos = via === 'lote' ? STATUS_CANCELAVEIS_EM_LOTE : STATUS_CANCELAVEIS_PELO_HUMANO;
  let atual: Map<number, string | null>;
  try {
    atual = await statusAtual(pedidos.map((p) => p.id), client);
  } catch (e) {
    const motivo = `não consegui reler o status: ${mensagemDeErro(e) ?? 'erro sem mensagem'}`;
    r.falhas.push(...pedidos.map((p) => ({ id: p.id, motivo })));
    return r;
  }
  for (const p of pedidos) {
    if (!atual.has(p.id)) {
      r.pulados.push({ id: p.id, status: null, motivo: 'pedido não encontrado (removido ou regenerado)' });
      continue;
    }
    const status = atual.get(p.id) ?? null;
    if (status === null || !permitidos.has(status)) {
      const dica = via === 'lote' && status === 'aprovado_aguardando_disparo' ? ' — vete individualmente' : '';
      r.pulados.push({ id: p.id, status, motivo: `status atual "${status ?? 'desconhecido'}" não pode ser rejeitado por esta via${dica}` });
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

/** Resumo humano da partição — usado no toast e na auditoria. Sem "Sucesso" quando nada foi rejeitado. */
export function resumirRejeicao(r: ResultadoRejeicao): { texto: string; nivel: 'success' | 'warning' | 'error' } {
  const partes = [`${r.rejeitados.length} rejeitado(s)`];
  if (r.pulados.length > 0) {
    const porStatus = new Map<string, number>();
    for (const p of r.pulados) porStatus.set(p.status ?? 'desconhecido', (porStatus.get(p.status ?? 'desconhecido') ?? 0) + 1);
    partes.push(`${r.pulados.length} pulado(s) (${[...porStatus].map(([s, n]) => `${n}× ${s}`).join(', ')})`);
  }
  if (r.falhas.length > 0) partes.push(`${r.falhas.length} com falha (${r.falhas[0].motivo}${r.falhas.length > 1 ? ', …' : ''})`);
  const texto = partes.join(', ');
  if (r.falhas.length > 0) return { texto, nivel: 'error' };
  if (r.pulados.length > 0 || r.rejeitados.length === 0) return { texto, nivel: 'warning' };
  return { texto, nivel: 'success' };
}
