import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Phone, PhoneOff, PhoneCall, PhoneIncoming, Loader2, Volume2, AlertCircle, X,
  Mic, MicOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { formatBrPhone, normalizeBrPhone } from '@/lib/phone';
import { useImpersonation } from '@/contexts/ImpersonationContext';

type CallDialerCallState =
  | 'idle' | 'connecting' | 'calling_origin' | 'calling_destination'
  | 'established' | 'finished' | 'noanswer' | 'busy' | 'failed' | 'error';

export interface CallDialerViewProps {
  phoneNumber: string;
  customerName: string;
  callState: CallDialerCallState;
  callDuration: number;
  audioLink: string | null;
  error: string | null;
  isActive: boolean;
  isConnecting: boolean;
  isRinging: boolean;
  isEstablished: boolean;
  isFinished: boolean;
  onMakeCall: (phone: string) => void;
  onEndCall: () => void;
  onCallEnd?: (data: { duration: number; state: CallDialerCallState; audioLink: string | null }) => void;
  compact?: boolean;
  floating?: boolean;
  /** ID para identificar visualmente backend (ex.: badge "WebRTC" vs "Nvoip") */
  backendLabel?: 'Nvoip' | 'WebRTC';
  /** Stream remoto do peer (cliente) — usado pra tocar áudio na chamada WebRTC.
   *  Nvoip click-to-call passa null/undefined aqui (não tem stream local). */
  remoteStream?: MediaStream | null;
  /** Estado do mic. Undefined em Nvoip (sem mute na UI). */
  isMuted?: boolean;
  /** Toggle do mic. Undefined em Nvoip. */
  onToggleMute?: () => void;
  /** True durante reprodução do pre-roll LGPD. */
  prerollPlaying?: boolean;
  /** Timestamp Date.now() em que o preroll termina. Pra countdown. */
  prerollEndsAt?: number | null;
}

const STATE_LABELS: Record<CallDialerCallState, string> = {
  idle: 'Pronto',
  connecting: 'Conectando...',
  calling_origin: 'Chamando ramal...',
  calling_destination: 'Chamando...',
  established: 'Em chamada',
  finished: 'Finalizada',
  noanswer: 'Sem resposta',
  busy: 'Ocupado',
  failed: 'Falhou',
  error: 'Erro',
};

const STATE_COLORS: Record<CallDialerCallState, string> = {
  idle: 'text-muted-foreground',
  connecting: 'text-status-warning',
  calling_origin: 'text-status-warning',
  calling_destination: 'text-status-warning',
  established: 'text-status-success',
  finished: 'text-muted-foreground',
  noanswer: 'text-status-warning',
  busy: 'text-status-error',
  failed: 'text-status-error',
  error: 'text-status-error',
};

function formatTimer(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallDialerView(props: CallDialerViewProps) {
  const {
    phoneNumber, customerName, callState, callDuration, audioLink, error,
    isActive, isConnecting, isRinging, isEstablished, isFinished,
    onMakeCall, onEndCall, onCallEnd, compact = false, floating = false, backendLabel,
  } = props;

  const [dismissed, setDismissed] = useState(false);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  const [prerollRemainingSeconds, setPrerollRemainingSeconds] = useState(0);

  useEffect(() => {
    if (!props.prerollPlaying || !props.prerollEndsAt) {
      setPrerollRemainingSeconds(0);
      return;
    }
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((props.prerollEndsAt! - Date.now()) / 1000));
      setPrerollRemainingSeconds(remaining);
    };
    updateCountdown();
    const id = window.setInterval(updateCountdown, 200);
    return () => clearInterval(id);
  }, [props.prerollPlaying, props.prerollEndsAt]);

  useEffect(() => {
    if (remoteAudioRef.current && props.remoteStream) {
      remoteAudioRef.current.srcObject = props.remoteStream;
    } else if (remoteAudioRef.current && !props.remoteStream) {
      remoteAudioRef.current.srcObject = null;
    }
  }, [props.remoteStream]);

  const { isImpersonating } = useImpersonation();
  const displayPhone = formatBrPhone(phoneNumber);
  const hasValidPhone = normalizeBrPhone(phoneNumber).length >= 10;

  useEffect(() => {
    if (isFinished && onCallEnd) {
      onCallEnd({ duration: callDuration, state: callState, audioLink });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFinished]);

  if (dismissed) return null;

  // Compact: just call button
  if (compact && callState === 'idle') {
    return (
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-status-success hover:bg-status-success-bg"
        onClick={() => onMakeCall(phoneNumber)}
        disabled={!hasValidPhone || isImpersonating}
        title={isImpersonating ? 'Ligação indisponível em modo Ver como' : (hasValidPhone ? `Ligar para ${displayPhone}` : 'Telefone inválido')}
      >
        <Phone className="w-4 h-4" />
      </Button>
    );
  }

  // Idle (non-compact, non-floating): full button
  if (!isActive && !isFinished && callState !== 'error' && !floating) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5 text-xs h-8"
        onClick={() => onMakeCall(phoneNumber)}
        disabled={!hasValidPhone || isImpersonating}
        title={isImpersonating ? 'Ligação indisponível em modo Ver como' : undefined}
      >
        <Phone className="w-3.5 h-3.5" /> Ligar {hasValidPhone ? displayPhone : ''}
      </Button>
    );
  }

  // Active or result panel
  const cardClass = cn(
    'border-2 transition-colors',
    isEstablished && 'border-status-success',
    isRinging && 'border-status-warning',
    isConnecting && 'border-status-warning/70',
    isFinished && 'border-border',
    callState === 'error' && 'border-status-error',
    floating && 'shadow-lg',
  );

  const cardContent = (
    <CardContent className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isRinging && <PhoneCall className="w-4 h-4 text-status-warning animate-pulse" />}
          {isEstablished && <PhoneIncoming className="w-4 h-4 text-status-success" />}
          {isConnecting && <Loader2 className="w-4 h-4 text-status-warning animate-spin" />}
          {callState === 'error' && <AlertCircle className="w-4 h-4 text-status-error" />}
          <div>
            <p className="text-sm font-medium">{customerName}</p>
            <p className="text-xs text-muted-foreground">{displayPhone}</p>
          </div>
        </div>
        {(isFinished || callState === 'error') && (
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setDismissed(true)}>
            <X className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {props.prerollPlaying && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-status-warning bg-status-warning-bg p-2 text-xs">
          <Volume2 className="w-4 h-4 text-status-warning shrink-0 animate-pulse" />
          <span className="font-medium text-status-warning">
            🔇 Aviso de gravação LGPD tocando — espere {prerollRemainingSeconds}s antes de falar
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn('text-xs', STATE_COLORS[callState])}>
            {STATE_LABELS[callState]}
          </Badge>
          {backendLabel && (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide opacity-60">
              {backendLabel}
            </Badge>
          )}
          {(isEstablished || isFinished) && (
            <span className="text-lg font-mono font-bold tabular-nums">{formatTimer(callDuration)}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {audioLink && (
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" asChild>
              <a href={audioLink} target="_blank" rel="noopener noreferrer">
                <Volume2 className="w-3 h-3" /> Ouvir
              </a>
            </Button>
          )}
          {isActive && props.onToggleMute && (
            <Button
              size="sm"
              variant={props.isMuted ? 'destructive' : 'outline'}
              className="h-8 text-xs gap-1"
              onClick={props.onToggleMute}
              title={props.isMuted ? 'Desmutar microfone' : 'Mutar microfone'}
            >
              {props.isMuted ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
            </Button>
          )}
          {isActive && (
            <Button size="sm" variant="destructive" className="h-8 text-xs gap-1" onClick={onEndCall}>
              <PhoneOff className="w-3 h-3" /> Encerrar
            </Button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-status-error mt-2">{error}</p>}
    </CardContent>
  );

  const card = <Card className={cardClass}>{cardContent}</Card>;

  if (floating) {
    return (
      <>
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
        <div className="fixed bottom-20 left-4 right-4 z-50 md:left-auto md:right-6 md:max-w-sm">
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0, y: 40, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 40, scale: 0.95 }}
            >
              {card}
            </motion.div>
          </AnimatePresence>
        </div>
      </>
    );
  }

  return (
    <>
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
        >
          {card}
        </motion.div>
      </AnimatePresence>
    </>
  );
}
