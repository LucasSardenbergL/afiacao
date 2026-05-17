import { Loader2, AlertCircle, Lightbulb, AlertTriangle, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { SpinAnalysis, SpinAnalysisStatus, SpinStage } from '@/lib/spin/types';

interface SpinSuggestionCardProps {
  status: SpinAnalysisStatus;
  analysis: SpinAnalysis | null;
  error: string | null;
}

const STAGE_LABEL: Record<SpinStage, string> = {
  opening: 'Abertura',
  situation: 'Situação',
  problem: 'Problema',
  implication: 'Implicação',
  need_payoff: 'Need-Payoff',
  closing: 'Fechamento',
};

const STAGE_COLOR: Record<SpinStage, string> = {
  opening: 'bg-muted text-muted-foreground',
  situation: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300',
  problem: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300',
  implication: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300',
  need_payoff: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300',
  closing: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300',
};

/**
 * Card sticky no rodapé do TranscriptionPanel mostrando a sugestão SPIN atual.
 * Vendedor LÊ literalmente o `exactPhrasing` da próxima ação.
 */
export function SpinSuggestionCard({ status, analysis, error }: SpinSuggestionCardProps) {
  if (status === 'idle') {
    return (
      <div className="border-t border-border p-3 bg-muted/30">
        <div className="text-2xs text-muted-foreground text-center">
          Copilot SPIN aguardando a primeira fala do cliente…
        </div>
      </div>
    );
  }

  if (status === 'analyzing' && !analysis) {
    return (
      <div className="border-t border-border p-3 bg-muted/30">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Copilot analisando…
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="border-t border-border p-3 bg-status-error-bg">
        <div className="flex items-start gap-2 text-xs">
          <AlertCircle className="w-3.5 h-3.5 text-status-error shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-status-error">Erro no copilot SPIN</div>
            {error && <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  if (!analysis) return null;

  const { spinStage, confidence, nextBestAction, risks, crossSellTriggers } = analysis;
  const stageColor = STAGE_COLOR[spinStage];
  const stageLabel = STAGE_LABEL[spinStage];

  return (
    <div className="border-t border-border bg-card p-3 space-y-3">
      {/* Header: stage + confidence */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-status-warning" />
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Sugestão Copilot
          </span>
          <Badge variant="outline" className={cn('text-2xs', stageColor)}>
            {stageLabel}
          </Badge>
        </div>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {Math.round(confidence * 100)}% conf.
        </span>
      </div>

      {/* Próxima ação — destaque visual */}
      <div className="space-y-1">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">
          Próxima pergunta sugerida:
        </div>
        <blockquote className="text-sm font-medium text-foreground border-l-2 border-status-success pl-3 italic">
          "{nextBestAction.exactPhrasing}"
        </blockquote>
        <div className="text-2xs text-muted-foreground">
          <span className="font-medium">Por quê:</span> {nextBestAction.whyNow}
        </div>
      </div>

      {/* Riscos (se houver) */}
      {risks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {risks.map((risk, idx) => (
            <Badge
              key={idx}
              variant="outline"
              className={cn(
                'text-2xs gap-1',
                risk.severity === 'high' && 'border-status-error text-status-error',
                risk.severity === 'medium' && 'border-status-warning text-status-warning',
              )}
              title={risk.note}
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              {risk.type.replace(/_/g, ' ')}
            </Badge>
          ))}
        </div>
      )}

      {/* Cross-sell hints (PR4 vai consumir) */}
      {crossSellTriggers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border/50">
          <div className="text-2xs text-muted-foreground flex items-center gap-1">
            <ShoppingCart className="w-3 h-3" />
            Oportunidade cross-sell:
          </div>
          {crossSellTriggers.map((t, idx) => (
            <Badge key={idx} variant="outline" className="text-2xs">
              {t.productHint}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
