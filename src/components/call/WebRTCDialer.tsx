import { useId } from 'react';
import { toast } from 'sonner';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { useWebRTCCallContextOptional } from '@/contexts/WebRTCCallContext';
import { CallDialerView, type CallDialerViewProps } from './CallDialerView';

type Props = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact' | 'floating'>;

/**
 * Dialer WebRTC in-app. A sessão WebRTC é ÚNICA/global (WebRTCCallContext), então
 * em telas com VÁRIOS dialers (listas: agenda, carteira) só o dialer que INICIOU a
 * chamada (owner, via claimCall) reflete o estado ativo; os demais ficam idle.
 * Sem isso, todos mostrariam o card ativo e disparariam onCallEnd → a chamada seria
 * registrada/preenchida na linha errada (ou em várias).
 *
 * Usa o contexto OPCIONAL: se o provider ainda não montou (cold load), degrada pro
 * botão idle em vez de lançar (não derruba a árvore).
 */
export function WebRTCDialer(props: Props) {
  const id = useId();
  const ctx = useWebRTCCallContextOptional();
  // `owned` = este dialer é o dono da chamada atual (e o contexto existe).
  const owned = ctx && ctx.callOwnerId === id ? ctx : null;
  // Sessão WebRTC é única: há uma chamada em curso (de qualquer linha)?
  const busy = !!ctx && (ctx.isActive || ctx.isConnecting || ctx.isRinging || ctx.isEstablished);

  return (
    <CallDialerView
      {...props}
      callState={owned ? owned.callState : 'idle'}
      callDuration={owned ? owned.callDuration : 0}
      audioLink={owned ? owned.audioLink : null}
      error={owned ? owned.error : null}
      isActive={!!owned && owned.isActive}
      isConnecting={!!owned && owned.isConnecting}
      isRinging={!!owned && owned.isRinging}
      isEstablished={!!owned && owned.isEstablished}
      isFinished={!!owned && owned.isFinished}
      onMakeCall={() => {
        if (!ctx) return;
        if (isLensActive()) {
          toast.error('Ligação indisponível na lente (somente leitura). Saia da lente para ligar.');
          return;
        }
        // Não rouba uma chamada ativa de OUTRA linha (a sessão é única). Sem isso,
        // clicar outra linha transferia o card e tentava uma 2ª chamada concorrente.
        if (busy && !owned) {
          toast.info('Já existe uma chamada em andamento');
          return;
        }
        ctx.claimCall(id);
        void ctx.makeCall(props.phoneNumber);
      }}
      onEndCall={() => { void ctx?.endCall(); }}
      remoteStream={owned ? owned.remoteStream : null}
      isMuted={!!owned && owned.isMuted}
      onToggleMute={() => ctx?.toggleMute()}
      prerollPlaying={!!owned && owned.prerollPlaying}
      prerollEndsAt={owned ? owned.prerollEndsAt : null}
      backendLabel="WebRTC"
    />
  );
}
