import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { WebRTCCallProvider } from './WebRTCCallContext';

/**
 * Monta o WebRTCCallProvider apenas para usuários staff (employee/master).
 *
 * Por quê: o Provider instancia um SipClient na hora do mount e tenta
 * REGISTER imediatamente via Edge Function `nvoip-sip-creds` (que rejeita
 * customers com 403). Para customers/anonymous, montar é desperdício +
 * polui logs com erros 403 esperados.
 *
 * Para staff, monta normalmente — uma única instância compartilhada via
 * Context entre todos os <WebRTCDialer> da árvore.
 */
export function ConditionalWebRTCProvider({ children }: { children: ReactNode }) {
  const { isStaff } = useAuth();

  if (!isStaff) {
    return <>{children}</>;
  }

  return <WebRTCCallProvider>{children}</WebRTCCallProvider>;
}
