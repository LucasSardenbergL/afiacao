import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { useNvoipCall } from '@/hooks/useNvoipCall';
import { useWebRTCCall } from '@/hooks/useWebRTCCall';

/**
 * Dispatcher único pra escolha do backend de telefonia.
 * Substitui o uso direto de useNvoipCall e useWebRTCCall em consumers
 * (modal "Nova ligação", dialers, etc.), garantindo que a feature flag
 * `useWebRTCCall` é o ponto único de verdade.
 *
 * Returns a união das APIs (campos comuns + extras). O backend ativo é
 * identificado em `backend` ('nvoip' | 'webrtc').
 *
 * IMPORTANTE: Ambos os hooks são chamados em TODO render — React requer
 * que hooks sejam chamados em ordem fixa. O custo é negligível
 * (useNvoipCall é estado local; useWebRTCCall é consumer de Context).
 *
 * IMPORTANTE 2: Quando webrtc está on, useWebRTCCall lança se a árvore
 * não estiver dentro de <WebRTCCallProvider>. Por isso esse hook deve
 * ser consumido apenas em rotas envolvidas pelo ConditionalWebRTCProvider
 * (todas as rotas autenticadas via AppShellLayout).
 */
export function useCallBackend() {
  const [useWebRTC] = useFeatureFlag('useWebRTCCall', false);
  const nvoip = useNvoipCall();
  const webrtc = useWebRTCCall();

  if (useWebRTC) {
    return { ...webrtc, backend: 'webrtc' as const };
  }
  return { ...nvoip, backend: 'nvoip' as const };
}
