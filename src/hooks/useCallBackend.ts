import { useWebRTCCall, useWebRTCCallOpcional } from '@/hooks/useWebRTCCall';

/**
 * Dispatcher do backend de telefonia.
 *
 * WebRTC in-browser é o ÚNICO caminho ativo: o vendedor liga direto pelo navegador
 * (grava + copiloto/transcrição ao vivo, funciona no celular). O click-to-call da
 * Nvoip foi DESCONTINUADO da interface — `useNvoipCall`/`NvoipDialer` viram código
 * dormente (mantidos por ora p/ revert fácil; remoção futura como faxina).
 *
 * Mantém o campo `backend` no retorno por compatibilidade com os consumidores
 * (CallDialerView, FarmerCalls) que checam 'webrtc' | 'nvoip'.
 *
 * IMPORTANTE: `useWebRTCCall` lança se a árvore não estiver dentro de
 * <WebRTCCallProvider>. Por isso este hook só pode ser consumido em rotas
 * envolvidas pelo ConditionalWebRTCProvider (rotas autenticadas via AppShellLayout).
 */
export function useCallBackend() {
  const webrtc = useWebRTCCall();
  return { ...webrtc, backend: 'webrtc' as const };
}

const SEM_TELEFONIA = {
  callState: 'idle' as const,
  callDuration: 0,
  error: null,
  isActive: false,
  isConnecting: false,
  isRinging: false,
  isEstablished: false,
  isFinished: false,
  makeCall: async (_phoneNumber: string) => {},
  endCall: async () => {},
  backend: 'indisponivel' as const,
};

/**
 * Para telas FORA do módulo Telefonia (FarmerCalls): sem Provider — módulo
 * congelado ou cold-load do lazy — devolve backend 'indisponivel' em vez de
 * lançar, e a tela cai no cronômetro manual.
 */
export function useCallBackendOpcional() {
  const webrtc = useWebRTCCallOpcional();
  return webrtc ? { ...webrtc, backend: 'webrtc' as const } : SEM_TELEFONIA;
}
