import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, MessageSquareText, Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import { useWebRTCCallContextOptional } from '@/contexts/webrtc-call-context';
import { useMunicaoLigacao } from '@/hooks/useMunicaoLigacao';
import { MunicaoResumo } from './MunicaoResumo';
import { SpinSuggestionCard } from './SpinSuggestionCard';
import { TranscriptionPanel } from './TranscriptionPanel';
import { formatBrPhone } from '@/lib/phone';

/**
 * Co-piloto flutuante GLOBAL durante a ligação. Persiste na navegação;
 * leva pro pedido com origem (por direção) + atendimento_id.
 * Coexiste com o painel do /farmer/calls (Fase 3 consolida).
 *
 * ⛔ Importa APENAS do módulo LEVE webrtc-call-context (não arrasta jssip).
 */
export function CallCopilotHud() {
  const ctx = useWebRTCCallContextOptional();
  const navigate = useNavigate();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { municao } = useMunicaoLigacao(ctx?.currentCustomerUserId ?? null);

  if (!ctx || ctx.callState !== 'established') return null;

  const customerId = ctx.currentCustomerUserId;
  const partyName = ctx.currentParty?.contactName ?? null;
  const origem =
    ctx.callDirection === 'inbound' ? 'ligacao_entrante' : 'ligacao_sainte';

  const montarPedido = () => {
    if (!customerId) {
      track('ligacao.montar_pedido', { tem_cliente: false });
      navigate('/sales/new');
      return;
    }
    const params = new URLSearchParams({ customer: customerId, origem });
    if (ctx.currentAtendimentoId) params.set('atendimento', ctx.currentAtendimentoId);
    track('ligacao.montar_pedido', { tem_cliente: true, origem });
    navigate(`/sales/new?${params.toString()}`);
  };

  return (
    <>
      <div className="fixed bottom-4 left-4 z-40 w-[320px] rounded-lg border border-border bg-card shadow-lg">
        <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-status-success animate-pulse shrink-0" />
            <span className="text-sm font-medium truncate">
              {partyName ??
                (ctx.currentParty?.phoneNormalized
                  ? formatBrPhone(ctx.currentParty.phoneNormalized)
                  : 'Em ligação')}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={ctx.toggleMute}
              title={ctx.isMuted ? 'Reativar mic' : 'Mutar'}
            >
              {ctx.isMuted ? (
                <MicOff className="w-4 h-4 text-status-error" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => void ctx.endCall()}
              title="Encerrar"
            >
              <PhoneOff className="w-4 h-4 text-status-error" />
            </Button>
          </div>
        </header>

        {municao && (
          <div className="px-3 py-2 border-b border-border">
            <MunicaoResumo municao={municao} />
          </div>
        )}

        <div className="max-h-[40vh] overflow-y-auto">
          <SpinSuggestionCard
            status={ctx.spinAnalysisStatus}
            analysis={ctx.spinAnalysis}
            error={ctx.spinAnalysisError}
          />
        </div>

        <footer className="flex items-center gap-2 p-2 border-t border-border">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5"
            onClick={() =>
              setTranscriptOpen((v) => {
                if (!v) track('ligacao.transcricao_aberta');
                return !v;
              })
            }
          >
            <MessageSquareText className="w-3.5 h-3.5" /> Transcrição
          </Button>
          <Button size="sm" className="flex-1 gap-1.5" onClick={montarPedido}>
            <ShoppingCart className="w-3.5 h-3.5" /> Montar pedido
          </Button>
        </footer>
      </div>

      <TranscriptionPanel
        status={ctx.transcriptionStatus}
        turns={ctx.transcriptionTurns}
        error={ctx.transcriptionError}
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        spinStatus={ctx.spinAnalysisStatus}
        spinAnalysis={ctx.spinAnalysis}
        spinError={ctx.spinAnalysisError}
      />
    </>
  );
}
