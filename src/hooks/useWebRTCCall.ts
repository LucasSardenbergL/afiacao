import { useWebRTCCallContext, type WebRTCCallContextValue } from '@/contexts/webrtc-call-context';

/**
 * Hook fino que delega TODO o state pro WebRTCCallContext.
 * Mantém a mesma API pública do hook original (drop-in compatível com PR1)
 * mas garante que um SipClient único é compartilhado entre todos os consumers
 * da página — corrige o bug de múltiplas instâncias REGISTER simultâneas.
 *
 * Requer que a árvore esteja envolvida por <WebRTCCallProvider>.
 */
export function useWebRTCCall(): WebRTCCallContextValue {
  return useWebRTCCallContext();
}
