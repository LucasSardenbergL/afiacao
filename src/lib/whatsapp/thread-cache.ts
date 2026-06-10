import type { WaMessage } from '@/queries/useWhatsappInbox';

/** Prefixo das mensagens otimistas injetadas pelo useSendWhatsapp (onMutate). */
export const OPTIMISTIC_MSG_PREFIX = 'optimistic-';

export function isOptimisticMessage(m: WaMessage): boolean {
  return m.id.startsWith(OPTIMISTIC_MSG_PREFIX);
}

/** Monta a mensagem otimista do envio (aparece na thread na hora do clique). */
export function montarMensagemOtimista(
  conversationId: string,
  body: string,
  nowIso: string,
): WaMessage {
  return {
    id: `${OPTIMISTIC_MSG_PREFIX}${nowIso}-${Math.floor(Math.random() * 1e6)}`,
    conversation_id: conversationId,
    direction: 'out',
    type: 'text',
    body,
    status: 'enviando',
    created_at: nowIso,
    wa_timestamp: null,
  };
}

/**
 * Append incremental de uma mensagem vinda do realtime no cache da thread
 * (substitui o invalidate que re-baixava a conversa INTEIRA a cada mensagem).
 *
 * Regras (todas testadas):
 *  - cache ausente → não cria (o fetch da thread popula quando a tela abrir);
 *  - dedupe por id (replay/duplicata do realtime não duplica balão);
 *  - mensagem OUT substitui a 1ª otimista de mesmo body (o INSERT real da
 *    mensagem que o próprio usuário enviou chega via realtime antes do
 *    invalidate de reconciliação — sem isso o balão duplicaria por ~1s).
 */
export function appendRealtimeMessage(
  old: WaMessage[] | undefined,
  nova: WaMessage,
): WaMessage[] | undefined {
  if (!old) return undefined;
  if (old.some((m) => m.id === nova.id)) return old;

  if (nova.direction === 'out') {
    const idx = old.findIndex((m) => isOptimisticMessage(m) && m.body === nova.body);
    if (idx >= 0) {
      const next = old.slice();
      next.splice(idx, 1);
      next.push(nova);
      return next;
    }
  }
  return [...old, nova];
}
