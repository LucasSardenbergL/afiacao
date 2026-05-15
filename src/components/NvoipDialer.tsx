import { useNvoipCall, type NvoipCallState } from '@/hooks/useNvoipCall';
import { CallDialerView, type CallDialerViewProps } from './call/CallDialerView';

type SharedProps = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact'>;

export type { NvoipCallState };

export function NvoipDialer(props: SharedProps) {
  const call = useNvoipCall();
  return (
    <CallDialerView
      {...props}
      callState={call.callState}
      callDuration={call.callDuration}
      audioLink={call.audioLink}
      error={call.error}
      isActive={call.isActive}
      isConnecting={call.isConnecting}
      isRinging={call.isRinging}
      isEstablished={call.isEstablished}
      isFinished={call.isFinished}
      onMakeCall={call.makeCall}
      onEndCall={call.endCall}
      backendLabel="Nvoip"
    />
  );
}

export function NvoipFloatingDialer(props: SharedProps) {
  const call = useNvoipCall();
  return (
    <CallDialerView
      {...props}
      floating
      callState={call.callState}
      callDuration={call.callDuration}
      audioLink={call.audioLink}
      error={call.error}
      isActive={call.isActive}
      isConnecting={call.isConnecting}
      isRinging={call.isRinging}
      isEstablished={call.isEstablished}
      isFinished={call.isFinished}
      onMakeCall={call.makeCall}
      onEndCall={call.endCall}
      backendLabel="Nvoip"
    />
  );
}
