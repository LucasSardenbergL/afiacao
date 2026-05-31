import { isStopKeyword } from './stop-keyword';

export type OptInStatus = 'unknown' | 'opt_in' | 'opt_out';

/**
 * Próximo opt_in_status de uma conversa dado o estado atual e o corpo do inbound.
 * - "PARAR"/"SAIR"/... → opt_out (LGPD, tem precedência).
 * - opt_out é STICKY: mensagem comum não reverte (re-inscrição é ação explícita à parte).
 * - opt_in permanece opt_in.
 * - unknown / vazio (primeira resposta do cliente) → opt_in (a resposta É consentimento).
 */
export function nextOptInStatus(current: string, body: string | null): OptInStatus {
  if (isStopKeyword(body)) return 'opt_out';
  if (current === 'opt_out') return 'opt_out';
  if (current === 'opt_in') return 'opt_in';
  return 'opt_in';
}
