import { lazy, Suspense } from 'react';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { NvoipDialer, NvoipFloatingDialer } from '@/components/NvoipDialer';
import type { CallDialerViewProps } from './CallDialerView';

const WebRTCDialer = lazy(() =>
  import('./WebRTCDialer').then((m) => ({ default: m.WebRTCDialer }))
);

type Props = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact' | 'floating'>;

export function Dialer(props: Props) {
  const [useWebRTC] = useFeatureFlag('useWebRTCCall', false);

  if (useWebRTC) {
    return (
      <Suspense fallback={null}>
        <WebRTCDialer {...props} />
      </Suspense>
    );
  }
  if (props.floating) return <NvoipFloatingDialer {...props} />;
  return <NvoipDialer {...props} />;
}
