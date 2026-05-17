import { useEffect, useState } from 'react';
import { useWebRTCCallContext } from '@/contexts/WebRTCCallContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Phone, PhoneOff, Loader2 } from 'lucide-react';
import { formatBrPhone } from '@/lib/phone';
import { supabase } from '@/integrations/supabase/client';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';

/**
 * Modal centralizado que aparece quando uma chamada inbound chega no ramal SIP
 * do vendedor (PR-INBOUND-CALLS).
 *
 * Identifica cliente automaticamente via match de telefone em profiles.
 * Vendedor clica Atender → mesmo fluxo de áudio do outbound:
 * - rawMic + preroll LGPD da Sara mixado
 * - transcript Deepgram + copilot SPIN automáticos
 * - persistência em farmer_calls automática
 */
export function IncomingCallModal() {
  const { incomingCall, acceptIncoming, rejectIncoming } = useWebRTCCallContext();
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  // Tenta identificar cliente pelo telefone
  useEffect(() => {
    if (!incomingCall) {
      setResolvedName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { customerUserId } = await resolveCustomerByPhone(incomingCall.phone);
        if (cancelled || !customerUserId) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data } = await (supabase.from('profiles') as any)
          .select('name, razao_social')
          .eq('user_id', customerUserId)
          .maybeSingle();
        if (!cancelled && data) {
          setResolvedName(data.razao_social || data.name);
        }
      } catch {
        // ignore — modal mostra só telefone
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [incomingCall]);

  if (!incomingCall) return null;

  const displayLabel = resolvedName
    ?? incomingCall.displayName
    ?? formatBrPhone(incomingCall.phone);

  const handleAccept = async () => {
    setAccepting(true);
    try {
      await acceptIncoming();
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && rejectIncoming()}>
      <DialogContent
        className="max-w-md text-center"
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-center gap-2 text-base">
            <Phone className="w-4 h-4 animate-pulse text-status-success" />
            Chamada entrando
          </DialogTitle>
          <DialogDescription className="space-y-2 pt-4">
            <span className="block text-2xl font-semibold text-foreground">
              {displayLabel}
            </span>
            {resolvedName && (
              <span className="block text-xs text-muted-foreground">
                {formatBrPhone(incomingCall.phone)}
              </span>
            )}
            {!resolvedName && (
              <span className="block text-2xs text-status-warning">
                Cliente não identificado — após atender, cadastre novo prospect
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-3 pt-4">
          <Button
            variant="outline"
            size="lg"
            className="gap-2 border-status-error text-status-error hover:bg-status-error-bg"
            onClick={rejectIncoming}
            disabled={accepting}
          >
            <PhoneOff className="w-4 h-4" />
            Rejeitar
          </Button>
          <Button
            size="lg"
            className="gap-2 bg-status-success hover:bg-status-success/90"
            onClick={handleAccept}
            disabled={accepting}
          >
            {accepting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Phone className="w-4 h-4" />
            )}
            Atender
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
