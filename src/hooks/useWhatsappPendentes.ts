// ⚠️ NÃO LIGADO no v1 (Fase 1). A fonte "WhatsApp pendente" foi adiada p/ a Fase 3 (split):
// esta versão tem falso-negativo (cap 200 do inbox + proxy last_message_at, Codex P1).
// Na Fase 3, reescrever sobre query/RPC de pendentes (sem cap) com last_outbound_at real. Ver spec §4.
import { useMemo } from 'react';
import { useWhatsappConversations } from '@/queries/useWhatsappInbox';
import type { WaPendente } from '@/lib/fila/adapters/whatsappPendente';

const MS_24H = 24 * 60 * 60 * 1000;

/**
 * Conversas aguardando resposta da vendedora dentro da janela de 24h.
 *
 * Regra v1: `last_inbound_at` existe, está há < 24h, e NÃO há mensagem
 * posterior registrada em `last_message_at` (proxy de outbound).
 *
 * WaConversation não expõe `last_outbound_at` explícito; usamos
 * `last_message_at` como proxy: se `last_message_at > last_inbound_at`,
 * houve resposta depois da última mensagem do cliente, logo não está pendente.
 * Se `last_message_at` é null ou igual a `last_inbound_at`, ainda aguarda.
 */
export function useWhatsappPendentes(): { data: WaPendente[]; isLoading: boolean } {
  const conversas = useWhatsappConversations();

  const data = useMemo<WaPendente[]>(() => {
    const lista = conversas.data ?? [];
    const agora = Date.now();

    return lista
      .map((c): WaPendente | null => {
        if (!c.last_inbound_at) return null;

        const tInbound = Date.parse(c.last_inbound_at);
        if (!Number.isFinite(tInbound)) return null;

        const desdeMs = agora - tInbound;
        if (desdeMs > MS_24H) return null; // fora da janela de 24h

        // Se last_message_at é posterior ao last_inbound_at, staff já respondeu
        if (c.last_message_at) {
          const tLastMsg = Date.parse(c.last_message_at);
          if (Number.isFinite(tLastMsg) && tLastMsg > tInbound) return null;
        }

        return {
          conversationId: c.id,
          clienteUserId: c.customer_user_id,
          nome: c.contact_name,
          telefone: c.phone_e164,
          horasDesde: desdeMs / (1000 * 60 * 60),
        };
      })
      .filter((x): x is WaPendente => x !== null);
  }, [conversas.data]);

  return { data, isLoading: conversas.isLoading };
}
