import { useWebRTCCall } from '@/hooks/useWebRTCCall';
import { CallDialerView, type CallDialerViewProps } from './CallDialerView';

type Props = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact' | 'floating'>;

export function WebRTCDialer(props: Props) {
  const call = useWebRTCCall();

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
      remoteStream={call.remoteStream}
      isMuted={call.isMuted}
      onToggleMute={call.toggleMute}
      prerollPlaying={call.prerollPlaying}
      prerollEndsAt={call.prerollEndsAt}
      backendLabel="WebRTC"
    />
  );
}
