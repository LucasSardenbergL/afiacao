import { useEffect, useState } from 'react';

type Quality = 'online' | 'slow' | 'offline';

interface NetworkStatus {
  online: boolean;
  quality: Quality;
  /** Round-trip time estimado em ms quando disponível (NetworkInformation API). */
  rttMs: number | null;
  /** Tipo efetivo da conexão (4g, 3g, 2g, slow-2g) quando disponível. */
  effectiveType: string | null;
  /** ISO timestamp da última transição de estado. */
  lastChangeAt: string;
}

interface NavigatorConnection {
  rtt?: number;
  effectiveType?: string;
  addEventListener?: (event: string, handler: () => void) => void;
  removeEventListener?: (event: string, handler: () => void) => void;
}

function getConnection(): NavigatorConnection | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & {
    connection?: NavigatorConnection;
    mozConnection?: NavigatorConnection;
    webkitConnection?: NavigatorConnection;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
}

function snapshot(): NetworkStatus {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const conn = getConnection();
  const rtt = conn?.rtt ?? null;
  const effectiveType = conn?.effectiveType ?? null;
  const slow = effectiveType === '2g' || effectiveType === 'slow-2g' || (rtt !== null && rtt > 1500);
  return {
    online,
    quality: !online ? 'offline' : slow ? 'slow' : 'online',
    rttMs: rtt,
    effectiveType,
    lastChangeAt: new Date().toISOString(),
  };
}

/**
 * Reativo a mudanças de online/offline e (quando disponível) qualidade da conexão.
 * Usado pelo NetworkStatusIndicator no AppShell.
 */
export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(() => snapshot());

  useEffect(() => {
    const update = () => setStatus(snapshot());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const conn = getConnection();
    conn?.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      conn?.removeEventListener?.('change', update);
    };
  }, []);

  return status;
}
