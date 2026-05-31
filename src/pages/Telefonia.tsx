// src/pages/Telefonia.tsx
import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { DialPad } from '@/components/telefonia/DialPad';
import { CallHistoryTabs } from '@/components/telefonia/CallHistoryTabs';
import { CallDialerView } from '@/components/call/CallDialerView';
import { useCallBackend } from '@/hooks/useCallBackend';
import { useIsTelefoniaManager } from '@/hooks/useIsTelefoniaManager';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';
import type { CallLogTab } from '@/hooks/useCallLog';

export default function Telefonia() {
  const { user } = useAuth();
  const [tab, setTab] = useState<CallLogTab>('recentes');
  const [dialPrefill, setDialPrefill] = useState('');
  const [activePhone, setActivePhone] = useState('');
  const [activeName, setActiveName] = useState('');
  // Remonta o painel a cada nova tentativa → reseta o "dispensar" (X) do card anterior.
  const [callSeq, setCallSeq] = useState(0);
  const call = useCallBackend();
  const isManager = useIsTelefoniaManager();

  // Sessão de chamada ÚNICA: a página é dona; DialPad e o histórico só disparam.
  const startCall = useCallback(
    (phone: string, opts?: { forceRecord?: boolean }, name = '') => {
      // Guarda no nível da página: se já há chamada em andamento (ex.: tocar
      // "religar" no histórico durante uma chamada), NÃO troca número/nome
      // exibidos — senão o card da chamada ativa passaria a mostrar o número
      // novo e o operador poderia encerrar a chamada errada. O hook também
      // barra internamente; aqui é pra manter a UI coerente com o que está no ar.
      if (call.isActive) {
        toast.info('Já existe uma chamada em andamento');
        return;
      }
      const normalized = normalizeBrPhone(phone);
      setActivePhone(normalized);
      setActiveName(name);
      setCallSeq((n) => n + 1);
      call.makeCall(normalized, opts);
    },
    [call]
  );

  const busy = call.isActive || call.callState === 'connecting';

  // No backend WebRTC o áudio remoto, mute e o aviso LGPD vivem no hook. Sem
  // repassar isso, a chamada conectaria sem áudio tocando nesta tela. Em Nvoip
  // (click-to-call, sem stream local) não há nada disso → objeto vazio.
  const webrtcExtras =
    call.backend === 'webrtc'
      ? {
          remoteStream: call.remoteStream,
          isMuted: call.isMuted,
          onToggleMute: call.toggleMute,
          prerollPlaying: call.prerollPlaying,
          prerollEndsAt: call.prerollEndsAt,
        }
      : {};

  return (
    <div className="container py-6">
      <h1 className="text-xl font-semibold mb-4">Central de Telefonia</h1>
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex flex-col gap-3">
          <DialPad
            key={dialPrefill}
            initialPhone={dialPrefill}
            backend={call.backend}
            busy={busy}
            onCall={(phone, opts) => startCall(phone, opts)}
          />
          {call.callState !== 'idle' && (
            <CallDialerView
              key={callSeq}
              phoneNumber={activePhone}
              customerName={activeName || formatBrPhone(activePhone)}
              callState={call.callState}
              callDuration={call.callDuration}
              audioLink={call.audioLink}
              error={call.error}
              isActive={call.isActive}
              isConnecting={call.isConnecting}
              isRinging={call.isRinging}
              isEstablished={call.isEstablished}
              isFinished={call.isFinished}
              onMakeCall={() => startCall(activePhone)}
              onEndCall={call.endCall}
              backendLabel={call.backend === 'webrtc' ? 'WebRTC' : 'Nvoip'}
              {...webrtcExtras}
            />
          )}
        </div>
        <div className="flex-1 rounded-lg border border-border bg-card p-3">
          <CallHistoryTabs
            userId={user?.id} tab={tab} onTabChange={setTab}
            isManager={isManager}
            onCallBack={(phone, name) => { setDialPrefill(phone); startCall(phone, undefined, name); }}
          />
        </div>
      </div>
    </div>
  );
}
