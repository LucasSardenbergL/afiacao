import {
  Loader2,
  AlertCircle,
  Lightbulb,
  AlertTriangle,
  ShoppingCart,
  Search,
  GraduationCap,
  Target,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type {
  SpinAnalysis,
  SpinAnalysisStatus,
  SpinStage,
  CopilotPlaybook,
  TicketLeverage,
  DecisionPushTactic,
} from '@/lib/spin/types';

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
  situation: 'bg-status-info-bg text-status-info-foreground border-status-info/20',
  problem: 'bg-status-warning-bg text-status-warning-foreground border-status-warning/20',
  implication: 'bg-status-error-bg text-status-error-foreground border-status-error/20',
  need_payoff: 'bg-status-success-bg text-status-success-foreground border-status-success/20',
  closing: 'bg-status-purple-bg text-status-purple-foreground border-status-purple/20',
};

const PLAYBOOK_LABEL: Record<CopilotPlaybook, string> = {
  discovery: 'Descoberta',
  teach: 'Ensine',
  close: 'Feche',
};

const PLAYBOOK_ICON: Record<CopilotPlaybook, typeof Search> = {
  discovery: Search,
  teach: GraduationCap,
  close: Target,
};

const PLAYBOOK_COLOR: Record<CopilotPlaybook, string> = {
  discovery: 'bg-status-info-bg text-status-info-foreground border-status-info/20',
  teach: 'bg-status-warning-bg text-status-warning-foreground border-status-warning/20',
  close: 'bg-status-success-bg text-status-success-foreground border-status-success/20',
};

const LEVERAGE_LABEL: Record<TicketLeverage, string> = {
  anchor_premium: 'Apresente o premium primeiro',
  bundle: 'Sugira o sistema completo',
  reframe_cost: 'Vire pra custo por m²',
  none: '',
};

const TACTIC_LABEL: Record<DecisionPushTactic, string> = {
  recommendation: 'Recomende com convicção',
  risk_reversal: 'Tire o risco da mesa',
  simplification: 'Simplifique a decisão',
};

/**
 * Card sticky no rodapé do TranscriptionPanel mostrando a sugestão do copilot adaptativo.
 * Vendedor LÊ literalmente o `exactPhrasing` da próxima ação.
 *
 * Renderiza por playbook (discovery/teach/close) com elementos extras:
 * - teach → bloco warning com commercialInsight (dataPoint + reframe)
 * - close → badge success com decisionPushTactic JOLT
 * - qualquer → bloco warning de ticketLeverage quando tactic !== 'none'
 */
export function SpinSuggestionCard({ status, analysis, error }: SpinSuggestionCardProps) {
  if (status === 'idle') {
    return (
      <div className="border-t border-border p-3 bg-muted/30">
        <div className="text-2xs text-muted-foreground text-center">
          Copilot aguardando a primeira fala do cliente…
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
            <div className="font-medium text-status-error">Erro no copilot</div>
            {error && <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  if (!analysis) return null;

  const { spinStage, confidence, playbook, nextBestAction, ticketLeverage, risks, crossSellTriggers } = analysis;
  const stageColor = STAGE_COLOR[spinStage];
  const stageLabel = STAGE_LABEL[spinStage];
  const playbookColor = PLAYBOOK_COLOR[playbook];
  const playbookLabel = PLAYBOOK_LABEL[playbook];
  const PlaybookIcon = PLAYBOOK_ICON[playbook];

  return (
    <div className="border-t border-border bg-card p-3 space-y-3">
      {/* Header: playbook + stage + confidence */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={cn('text-2xs gap-1', playbookColor)}>
            <PlaybookIcon className="w-3 h-3" />
            {playbookLabel}
          </Badge>
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
        <div className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
          <Lightbulb className="w-3 h-3 text-status-warning" />
          Próxima fala sugerida:
        </div>
        <blockquote className="text-sm font-medium text-foreground border-l-2 border-status-success pl-3 italic">
          "{nextBestAction.exactPhrasing}"
        </blockquote>
        <div className="text-2xs text-muted-foreground">
          <span className="font-medium">Por quê:</span> {nextBestAction.whyNow}
        </div>
      </div>

      {/* TEACH: commercial insight (só quando playbook=teach + tem dataPoint) */}
      {playbook === 'teach' && nextBestAction.commercialInsight && (
        <div className="rounded-md border border-status-warning/20 bg-status-warning-bg/50 p-2.5 space-y-1.5">
          <div className="text-2xs uppercase tracking-wide text-status-warning-foreground flex items-center gap-1">
            <GraduationCap className="w-3 h-3" />
            Insight pra ensinar
          </div>
          <div className="text-xs text-foreground">{nextBestAction.commercialInsight.dataPoint}</div>
          <div className="text-2xs text-muted-foreground">
            <span className="font-medium">Reframe:</span> {nextBestAction.commercialInsight.reframe}
          </div>
        </div>
      )}

      {/* CLOSE: decisionPushTactic (só quando playbook=close + tem tactic) */}
      {playbook === 'close' && nextBestAction.decisionPushTactic && (
        <div className="flex items-center gap-1.5">
          <Target className="w-3 h-3 text-status-success" />
          <span className="text-2xs font-medium text-status-success">
            Tática JOLT: {TACTIC_LABEL[nextBestAction.decisionPushTactic]}
          </span>
        </div>
      )}

      {/* TICKET LEVERAGE: sempre, exceto quando tactic=none */}
      {ticketLeverage.tactic !== 'none' && (
        <div className="rounded-md border border-status-warning/20 bg-status-warning-bg/50 p-2.5 space-y-1">
          <div className="text-2xs uppercase tracking-wide text-status-warning-foreground flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />
            Subir ticket — {LEVERAGE_LABEL[ticketLeverage.tactic]}
          </div>
          <div className="text-2xs text-foreground">{ticketLeverage.suggestion}</div>
        </div>
      )}

      {/* Riscos */}
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

      {/* Cross-sell hints (PR9 vai consumir KB pra resolver pra SKU real) */}
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
