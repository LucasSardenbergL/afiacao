import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { NvoipDialer, NvoipFloatingDialer } from '@/components/NvoipDialer';
import { WebRTCDialer } from './WebRTCDialer';
import type { CallDialerViewProps } from './CallDialerView';

type Props = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact' | 'floating'>;

export function Dialer(props: Props) {
  const [useWebRTC] = useFeatureFlag('useWebRTCCall', false);

  if (useWebRTC) return <WebRTCDialer {...props} />;
  if (props.floating) return <NvoipFloatingDialer {...props} />;
  return <NvoipDialer {...props} />;
}
