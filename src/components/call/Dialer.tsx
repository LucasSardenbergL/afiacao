import { lazy, Suspense } from 'react';
import type { CallDialerViewProps } from './CallDialerView';

const WebRTCDialer = lazy(() =>
  import('./WebRTCDialer').then((m) => ({ default: m.WebRTCDialer }))
);

type Props = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact' | 'floating'>;

/**
 * Dialer in-app. WebRTC é o único backend ativo (o `floating` é repassado e
 * tratado pelo WebRTCDialer/CallDialerView). O Nvoip click-to-call foi
 * descontinuado da UI — ver useCallBackend.
 */
export function Dialer(props: Props) {
  return (
    <Suspense fallback={null}>
      <WebRTCDialer {...props} />
    </Suspense>
  );
}
