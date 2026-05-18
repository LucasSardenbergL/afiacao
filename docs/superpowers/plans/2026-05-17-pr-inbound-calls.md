# PR-INBOUND-CALLS — Atender chamadas que chegam ao ramal SIP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando cliente liga pro ramal SIP do vendedor (Nvoip rotea inbound), o app mostra **modal centralizado** com nome (se identificado via match de telefone) + telefone + botões `Atender` / `Rejeitar`. Click atender → mesmo fluxo de outbound: mic + preroll LGPD da Sara + transcript + copilot adaptativo + persistência em farmer_calls. Tudo automático.

**Architecture:**
- `SipClient` ganha handler `ua.on('newRTCSession', ...)` com filtro `originator === 'remote'`
- Sessão inbound fica guardada em ref + emite novo evento `incomingCall({ phone, callerName?, sessionRef })`
- `acceptIncoming(micStream)` chama `session.answer({ mediaStream })`
- `rejectIncoming()` chama `session.terminate({ status_code: 486 })` (busy here) ou `603` (decline)
- `WebRTCCallContext` ganha state `incomingCall: IncomingCallInfo | null` + funções `acceptIncoming(opts?)` / `rejectIncoming()` — internamente faz mesmo setup de áudio do outbound (rawMic + preroll mixed)
- Componente `IncomingCallModal` montado no `AppShell` (global) — escuta context + mostra modal quando `incomingCall != null`
- Tudo o mais (transcript, SPIN, persist) já funciona porque o context dispara mesmas hooks no `established`

**Não-objetivos:**
- Ringtone — modal só visual nesta v1
- Call waiting / hold — só uma chamada por vez
- Transferência interna — fora de escopo
- DTMF inbound (cliente discando opções) — fora

---

## File Structure

**Modificar:**
- `src/lib/sip/types.ts` — adicionar `IncomingCallInfo` + evento `incomingCall`
- `src/lib/sip/sip-client.ts` — handler newRTCSession + acceptIncoming/rejectIncoming
- `src/contexts/WebRTCCallContext.tsx` — state + funções incoming
- `src/components/AppShell.tsx` — render IncomingCallModal

**Criar:**
- `src/components/call/IncomingCallModal.tsx`

---

## Task 1: Types

`src/lib/sip/types.ts`:

```ts
export interface IncomingCallInfo {
  /** Telefone normalizado (E.164 ou só dígitos) extraído do FROM */
  phone: string;
  /** Display name do FROM SIP, se houver */
  displayName: string | null;
  /** Timestamp em que chegou */
  receivedAt: number;
}

export interface SipClientEvents {
  stateChange: (state: SipCallState) => void;
  localStream: (stream: MediaStream) => void;
  remoteStream: (stream: MediaStream) => void;
  error: (err: Error) => void;
  // NOVO em PR-INBOUND-CALLS:
  incomingCall: (info: IncomingCallInfo) => void;
}
```

---

## Task 2: SipClient inbound

Adicionar em `constructor` após os handlers existentes:

```ts
// JsSIP event tipado loosely — incoming RTCSession
// eslint-disable-next-line @typescript-eslint/no-explicit-any
this.ua.on('newRTCSession', (e: any) => {
  const session = e.session;
  if (e.originator !== 'remote') {
    // Outbound — ignorado aqui (lifecycle já tratado em makeCall)
    return;
  }
  // Já tem chamada ativa? Auto-rejeita (busy)
  if (this.currentSession) {
    try { session.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch { /* noop */ }
    return;
  }

  // Guarda sessão pendente — ainda não answer
  this.pendingIncoming = session;

  // Extrai info do FROM
  const fromUri = session.remote_identity?.uri;
  const displayName = session.remote_identity?.display_name ?? null;
  const phone = fromUri?.user ?? 'desconhecido';

  this.emit('incomingCall', {
    phone,
    displayName,
    receivedAt: Date.now(),
  });

  // Se sessão for cancelada pelo caller antes do answer
  session.on('failed', () => {
    if (this.pendingIncoming === session) {
      this.pendingIncoming = null;
      this.emit('stateChange', 'idle');
    }
  });
});
```

Adicionar campo privado `private pendingIncoming: any = null;` no topo da classe.

Adicionar 2 métodos públicos:

```ts
acceptIncoming(micStream: MediaStream): void {
  if (!this.pendingIncoming) {
    throw new Error('Nenhuma chamada inbound pendente');
  }
  const session = this.pendingIncoming;
  this.pendingIncoming = null;
  this.currentSession = session;
  this.currentLocalStream = micStream;
  this.setState('established'); // answer é sincrono pra UI; SIP confirma logo
  this.emit('localStream', micStream);

  // answer com mediaStream do vendedor (mic + preroll mixed)
  session.answer({
    mediaStream: micStream,
    rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    pcConfig: {
      iceServers: this.config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
    },
  });

  this.callStartedAt = Date.now();

  // Extract remote depois de SDP exchange (mesma técnica do outbound)
  session.on('confirmed', () => this.extractRemoteStream());

  session.on('failed', (e: { cause?: string }) => {
    this.setState('failed');
    this.emit('error', new Error(`Inbound call failed: ${e.cause ?? 'unknown'}`));
  });
  session.on('ended', () => {
    this.setState('ended');
  });
}

rejectIncoming(): void {
  if (!this.pendingIncoming) return;
  try {
    this.pendingIncoming.terminate({ status_code: 603, reason_phrase: 'Decline' });
  } catch { /* noop */ }
  this.pendingIncoming = null;
  this.emit('stateChange', 'idle');
}
```

---

## Task 3: WebRTCCallContext

Adicionar state:

```ts
const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);
```

Adicionar listener no useEffect que cria o client:

```ts
client.on('incomingCall', (info) => setIncomingCall(info));
```

Reset incomingCall em transições pra established/ended/idle (via state machine ou direto em accept/reject/cleanup).

Funções públicas:

```ts
const acceptIncoming = useCallback(async () => {
  if (!incomingCall || !clientRef.current) return;

  // Reset refs de sessão (mesmo do makeCall)
  analysisHistoryRef.current = [];
  dialedPhoneRef.current = incomingCall.phone;  // tratado como "phone discado" pra persist
  callStartedAtRef.current = new Date();

  cleanupAudioResources();

  try {
    const rawMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    rawMicRef.current = rawMic;
    setVendorMicStream(rawMic);

    let streamForCall: MediaStream = rawMic;
    if (prerollUrl) {
      const mix = await mixPrerollWithMic(prerollUrl, rawMic);
      streamForCall = mix.stream;
      prerollPlayRef.current = mix.play;
      prerollCloseRef.current = mix.close;
      prerollDurationRef.current = mix.durationSeconds;
    }

    clientRef.current.acceptIncoming(streamForCall);
    setIncomingCall(null);
    toast.success('📞 Chamada atendida', { description: incomingCall.displayName ?? formatBrPhone(incomingCall.phone) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao atender';
    setError(msg);
    cleanupAudioResources();
    setIncomingCall(null);
    toast.error('Erro ao atender chamada', { description: msg });
  }
}, [incomingCall, prerollUrl]);

const rejectIncoming = useCallback(() => {
  if (!clientRef.current) return;
  clientRef.current.rejectIncoming();
  setIncomingCall(null);
  toast.info('Chamada rejeitada');
}, []);
```

Expor na interface do context:

```ts
incomingCall: IncomingCallInfo | null;
acceptIncoming: () => Promise<void>;
rejectIncoming: () => void;
```

---

## Task 4: IncomingCallModal

```tsx
import { useEffect, useState } from 'react';
import { useWebRTCCallContext } from '@/contexts/WebRTCCallContext';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Phone, PhoneOff, Loader2 } from 'lucide-react';
import { formatBrPhone } from '@/lib/phone';
import { supabase } from '@/integrations/supabase/client';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';

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
    return () => { cancelled = true; };
  }, [incomingCall]);

  if (!incomingCall) return null;

  const displayLabel = resolvedName
    ?? incomingCall.displayName
    ?? formatBrPhone(incomingCall.phone);

  const handleAccept = async () => {
    setAccepting(true);
    try { await acceptIncoming(); } finally { setAccepting(false); }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && rejectIncoming()}>
      <DialogContent className="max-w-md text-center" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center justify-center gap-2 text-base">
            <Phone className="w-4 h-4 animate-pulse text-status-success" />
            Chamada entrando
          </DialogTitle>
          <DialogDescription className="space-y-2 pt-4">
            <div className="text-2xl font-semibold text-foreground">{displayLabel}</div>
            {resolvedName && (
              <div className="text-xs text-muted-foreground">{formatBrPhone(incomingCall.phone)}</div>
            )}
            {!resolvedName && (
              <div className="text-2xs text-status-warning">Cliente não identificado — após atender, cadastre novo prospect</div>
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
            {accepting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
            Atender
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Task 5: AppShell renderiza modal global

Em `src/components/AppShell.tsx`, dentro do return do `AppShellContent` (ou após Outlet — local global), adicionar:

```tsx
import { IncomingCallModal } from '@/components/call/IncomingCallModal';

// no return:
<IncomingCallModal />
```

---

## Task 6: QA + PR

- tsc clean
- vitest passa (sem testes novos — UI interativa cobre via integration manual)
- bun build passa
- Push + PR

---

## Self-Review

**Spec coverage:**
- Atender chamada inbound → Tasks 2, 3
- Preroll LGPD pro cliente → Task 3 (reusa mixPrerollWithMic)
- Modal centralizado → Task 4
- Identificação automática via match phone → Task 4 (resolveCustomerByPhone)
- Mensagem "Cliente não identificado" pro prospect → Task 4
- Persist + transcript + copilot funcionam automático → context reusa hooks existentes

**Riscos:**
- Race condition se cliente cancela antes do vendedor atender — coberto por `session.on('failed')` na pending
- Pre-roll toca depois do answer (mesmo timing fix do outbound) — `prerollPlayRef.current` dispara via effect quando `callState === 'established'`. Reusa do PR1.5.
- Se vendedor recusa a permissão de microfone → throw no `getUserMedia` → toast erro. UX OK.
- Múltiplas tabs abertas — cada tab tem seu próprio SipClient registrado no mesmo ramal SIP. Nvoip vai forkar pra todas. Aceitável pra MVP (vendedor abre 1 tab).
