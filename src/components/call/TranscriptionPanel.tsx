import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, AlertCircle, X, Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';
import type { SpinAnalysis, SpinAnalysisStatus } from '@/lib/call/spin/types';
import { SpinSuggestionCard } from './SpinSuggestionCard';

interface TranscriptionPanelProps {
  status: TranscriptionStatus;
  turns: TranscriptTurn[];
  error: string | null;
  open: boolean;
  onClose: () => void;
  spinAnalysis?: SpinAnalysis | null;
  spinStatus?: SpinAnalysisStatus;
  spinError?: string | null;
}

/**
 * Painel lateral slide-in com transcrição ao vivo da chamada.
 * Bolhas alternadas estilo chat: vendedor (direita) vs cliente (esquerda).
 * Interim turns aparecem com opacidade reduzida + "digitando...".
 */
export function TranscriptionPanel({
  status,
  turns,
  error,
  open,
  onClose,
  spinAnalysis,
  spinStatus,
  spinError,
}: TranscriptionPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll pro final quando turns mudam
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={{ type: 'tween', duration: 0.2 }}
          className="fixed right-0 top-topbar bottom-0 w-full md:w-[400px] bg-card border-l border-border z-40 flex flex-col shadow-lg"
        >
          {/* Header */}
          <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm font-medium truncate">Transcrição ao vivo</h2>
              <StatusBadge status={status} />
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onClose} title="Fechar painel">
              <X className="w-4 h-4" />
            </Button>
          </header>

          {/* Body */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {status === 'connecting' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Conectando ao Deepgram...
              </div>
            )}
            {status === 'error' && (
              <div className="flex items-start gap-2 rounded-md border border-status-error bg-status-error-bg p-3 text-xs">
                <AlertCircle className="w-4 h-4 text-status-error shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-status-error">Erro na transcrição</div>
                  {error && <div className="text-muted-foreground mt-1 font-mono">{error}</div>}
                </div>
              </div>
            )}
            {status === 'active' && turns.length === 0 && (
              <div className="text-sm text-muted-foreground text-center pt-12">
                Aguardando fala...
              </div>
            )}
            {turns.map((turn) => (
              <TurnBubble key={turn.id} turn={turn} />
            ))}
          </div>

          {/* Footer: SpinSuggestionCard when spin props provided, fallback otherwise */}
          {spinStatus !== undefined ? (
            <div className="shrink-0">
              <SpinSuggestionCard
                status={spinStatus}
                analysis={spinAnalysis ?? null}
                error={spinError ?? null}
              />
            </div>
          ) : (
            <footer className="p-3 border-t border-border text-2xs text-muted-foreground text-center shrink-0">
              Transcrição via Deepgram Nova-3. Não armazenada (PR6 vai persistir).
            </footer>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function StatusBadge({ status }: { status: TranscriptionStatus }) {
  if (status === 'idle') return <Badge variant="outline" className="text-2xs">Idle</Badge>;
  if (status === 'connecting')
    return (
      <Badge variant="outline" className="text-2xs text-status-warning gap-1">
        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Conectando
      </Badge>
    );
  if (status === 'active')
    return (
      <Badge variant="outline" className="text-2xs text-status-success gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" /> Ao vivo
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-2xs text-status-error gap-1">
      <AlertCircle className="w-2.5 h-2.5" /> Erro
    </Badge>
  );
}

function TurnBubble({ turn }: { turn: TranscriptTurn }) {
  const isVendor = turn.speaker === 'vendedor';
  return (
    <div className={cn('flex flex-col gap-1', isVendor ? 'items-end' : 'items-start')}>
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        {isVendor ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />}
        <span>{isVendor ? 'Vendedor' : 'Cliente'}</span>
        {!turn.isFinal && (
          <span className="text-status-warning">• digitando...</span>
        )}
      </div>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm break-words',
          isVendor
            ? 'bg-foreground text-background'
            : 'bg-muted text-foreground border border-border',
          !turn.isFinal && 'opacity-70',
        )}
      >
        {turn.text}
      </div>
    </div>
  );
}
