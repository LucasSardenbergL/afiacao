import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Phone, PhoneOff, PhoneCall, PhoneIncoming,
  Loader2, Volume2, AlertCircle, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNvoipCall, type NvoipCallState } from '@/hooks/useNvoipCall';
import { motion, AnimatePresence } from 'framer-motion';

interface NvoipDialerProps {
  phoneNumber: string;
  customerName: string;
  onCallEnd?: (data: { duration: number; callId: string | null; audioLink: string | null; state: NvoipCallState }) => void;
  compact?: boolean;
}

const STATE_LABELS: Record<NvoipCallState, string> = {
  idle: 'Pronto',
  connecting: 'Conectando...',
  calling_origin: 'Chamando ramal...',
  calling_destination: 'Chamando destino...',
  established: 'Em chamada',
  finished: 'Finalizada',
  noanswer: 'Sem resposta',
  busy: 'Ocupado',
  failed: 'Falhou',
  error: 'Erro',
};

const STATE_COLORS: Record<NvoipCallState, string> = {
  idle: 'text-muted-foreground',
  connecting: 'text-amber-600',
  calling_origin: 'text-amber-600',
  calling_destination: 'text-amber-600',
  established: 'text-emerald-600',
  finished: 'text-muted-foreground',
  noanswer: 'text-amber-600',
  busy: 'text-destructive',
  failed: 'text-destructive',
  error: 'text-destructive',
};

function formatTimer(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function NvoipDialer({ phoneNumber, customerName, onCallEnd, compact = false }: NvoipDialerProps) {
  const {
    callState, callId, callDuration, audioLink,
    makeCall, endCall, isActive, isConnecting, isRinging, isEstablished, isFinished,
    error,
  } = useNvoipCall();

  const [dismissed, setDismissed] = useState(false);

  // Notify parent when call ends
  useEffect(() => {
    if (isFinished && onCallEnd) {
      onCallEnd({ duration: callDuration, callId, audioLink, state: callState });
    }
  }, [isFinished]);

  if (dismissed) return null;

  // Compact mode: just a button
  if (compact && callState === 'idle') {
    return (
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
        onClick={() => makeCall(phoneNumber)}
      >
        <Phone className="w-4 h-4" />
      </Button>
    );
  }

  // Active call or result overlay
  if (isActive || isFinished || callState === 'error') {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
        >
          <Card className={cn(
            'border-2 transition-colors',
            isEstablished && 'border-emerald-400 bg-emerald-50/50',
            isRinging && 'border-amber-400 bg-amber-50/50',
            isConnecting && 'border-amber-300 bg-amber-50/30',
            isFinished && 'border-border',
            callState === 'error' && 'border-destructive bg-destructive/5',
          )}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {isRinging && (
                    <PhoneCall className="w-4 h-4 text-amber-600 animate-pulse" />
                  )}
                  {isEstablished && (
                    <PhoneIncoming className="w-4 h-4 text-emerald-600" />
                  )}
                  {isConnecting && (
                    <Loader2 className="w-4 h-4 text-amber-600 animate-spin" />
                  )}
                  {callState === 'error' && (
                    <AlertCircle className="w-4 h-4 text-destructive" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{customerName}</p>
                    <p className="text-xs text-muted-foreground">{phoneNumber}</p>
                  </div>
                </div>
                {(isFinished || callState === 'error') && (
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setDismissed(true)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn('text-xs', STATE_COLORS[callState])}
                  >
                    {STATE_LABELS[callState]}
                  </Badge>
                  {(isEstablished || isFinished) && (
                    <span className="text-lg font-mono font-bold">
                      {formatTimer(callDuration)}
                    </span>
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
                  {isActive && (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-8 text-xs gap-1"
                      onClick={endCall}
                    >
                      <PhoneOff className="w-3 h-3" /> Encerrar
                    </Button>
                  )}
                </div>
              </div>

              {error && (
                <p className="text-xs text-destructive mt-2">{error}</p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </AnimatePresence>
    );
  }

  // Idle state
  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5 text-xs h-8 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
      onClick={() => makeCall(phoneNumber)}
    >
      <Phone className="w-3.5 h-3.5" /> Ligar via Nvoip
    </Button>
  );
}

/* ─── Floating Dialer (global overlay for active calls) ─── */
export function NvoipFloatingDialer({
  phoneNumber,
  customerName,
  onCallEnd,
}: NvoipDialerProps) {
  const {
    callState, callId, callDuration, audioLink,
    makeCall, endCall, isActive, isConnecting, isRinging, isEstablished, isFinished,
    error,
  } = useNvoipCall();

  // Auto-start call on mount
  useEffect(() => {
    if (callState === 'idle' && phoneNumber) {
      makeCall(phoneNumber);
    }
  }, []);

  useEffect(() => {
    if (isFinished && onCallEnd) {
      onCallEnd({ duration: callDuration, callId, audioLink, state: callState });
    }
  }, [isFinished]);

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 md:left-auto md:right-6 md:max-w-sm">
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 40, scale: 0.95 }}
        >
          <Card className={cn(
            'shadow-lg border-2',
            isEstablished && 'border-emerald-400',
            (isRinging || isConnecting) && 'border-amber-400',
            isFinished && 'border-border',
            callState === 'error' && 'border-destructive',
          )}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className={cn(
                  'w-10 h-10 rounded-full flex items-center justify-center',
                  isEstablished ? 'bg-emerald-100' : isRinging ? 'bg-amber-100' : 'bg-muted',
                )}>
                  {isConnecting ? (
                    <Loader2 className="w-5 h-5 animate-spin text-amber-600" />
                  ) : isRinging ? (
                    <PhoneCall className="w-5 h-5 text-amber-600 animate-pulse" />
                  ) : isEstablished ? (
                    <PhoneIncoming className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <Phone className="w-5 h-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold">{customerName}</p>
                  <p className="text-xs text-muted-foreground">{phoneNumber}</p>
                </div>
                {(isEstablished || isFinished) && (
                  <span className="text-2xl font-mono font-bold tabular-nums">
                    {formatTimer(callDuration)}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between">
                <Badge
                  variant="outline"
                  className={cn('text-xs', STATE_COLORS[callState])}
                >
                  {STATE_LABELS[callState]}
                </Badge>

                <div className="flex gap-2">
                  {audioLink && (
                    <Button size="sm" variant="outline" className="h-8 text-xs gap-1" asChild>
                      <a href={audioLink} target="_blank" rel="noopener noreferrer">
                        <Volume2 className="w-3 h-3" /> Gravação
                      </a>
                    </Button>
                  )}
                  {isActive && (
                    <Button size="sm" variant="destructive" className="h-8 gap-1" onClick={endCall}>
                      <PhoneOff className="w-4 h-4" /> Desligar
                    </Button>
                  )}
                </div>
              </div>

              {error && (
                <p className="text-xs text-destructive mt-2">{error}</p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
