// Fonte "WhatsApp pendente" da fila (ligada no PR-2 do Canal WhatsApp): pendência
// decidida no SQL pela RPC get_whatsapp_pendentes (sem cap do inbox, last_outbound_at
// REAL via trigger — o proxy last_message_at marcava template automático como resposta).
import type { AcaoSugerida, AcaoPayload } from '../types';

/** Conversa do inbox aguardando resposta da vendedora, dentro da janela de 24h. */
export interface WaPendente {
  conversationId: string;
  clienteUserId: string | null;
  nome: string | null;
  telefone: string | null;
  /** horas desde a última mensagem do cliente (inbound) ainda sem resposta */
  horasDesde: number;
}

/** Linha crua devolvida pela RPC get_whatsapp_pendentes (fora do types.ts gerado). */
interface WaPendenteRow {
  conversation_id?: unknown;
  customer_user_id?: unknown;
  contact_name?: unknown;
  phone_e164?: unknown;
  last_inbound_at?: unknown;
}

/**
 * Rows da RPC → WaPendente. A janela de 24h é cortada no SQL pelo relógio do
 * SERVIDOR (fonte da verdade); aqui só se computa horasDesde para exibição/score
 * — clamp em 0 cobre clock skew do cliente. Linha malformada é descartada.
 */
export function mapPendenteRows(rows: unknown, agoraMs: number): WaPendente[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r): WaPendente[] => {
    const row = r as WaPendenteRow;
    const conversationId = typeof row.conversation_id === 'string' ? row.conversation_id : '';
    const t = typeof row.last_inbound_at === 'string' ? Date.parse(row.last_inbound_at) : NaN;
    if (!conversationId || !Number.isFinite(t)) return [];
    return [{
      conversationId,
      clienteUserId: typeof row.customer_user_id === 'string' ? row.customer_user_id : null,
      nome: typeof row.contact_name === 'string' ? row.contact_name : null,
      telefone: typeof row.phone_e164 === 'string' ? row.phone_e164 : null,
      horasDesde: Math.max(0, (agoraMs - t) / 3_600_000),
    }];
  });
}

export function whatsappPendenteParaAcoes(pendentes: WaPendente[]): AcaoSugerida[] {
  return pendentes.map(p => ({
    fonte: 'whatsapp_pendente' as const,
    entidadeId: p.conversationId,
    clienteUserId: p.clienteUserId,
    clienteNome: p.nome,
    telefone: p.telefone,
    acao: 'Responder',
    titulo: `Responder ${p.nome ?? p.telefone ?? 'cliente'} no WhatsApp`,
    motivo: `Cliente respondeu há ${Math.round(p.horasDesde)}h e ninguém retornou`,
    categoria: 'prazo' as const,
    score: Math.max(0, Math.min(1, p.horasDesde / 24)),
    valorEsperado: null,
    tipoValor: 'sem_valor' as const,
    cta: 'whatsapp' as const,
    dedupeKey: `${p.clienteUserId ?? p.conversationId}:whatsapp`,
    payload: { kind: 'whatsapp', conversationId: p.conversationId } satisfies AcaoPayload,
  }));
}
