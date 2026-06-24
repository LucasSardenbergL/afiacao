// Card de plano tático (resumo + conteúdo expandido).
// Extraído verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).
import {
  Target, Heart, AlertTriangle, TrendingUp, Package,
  MessageSquare, Shield, ChevronDown, ChevronUp,
  Brain, DollarSign, BarChart3, AlertCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getObjectiveLabel, type TacticalPlan } from '@/hooks/useTacticalPlan';
import { fmt, objectiveColors, profileLabels } from './config';
import { Section, MetricRow, CopyButton } from './PlanSection';
import { RecordResultDialog } from './RecordResultDialog';
import type { RecordResultPayload } from './types';

export const PlanCard = ({
  plan, expanded, onToggle, onCopy, copiedText, onRecordResult,
}: {
  plan: TacticalPlan;
  expanded: boolean;
  onToggle: () => void;
  onCopy: (text: string) => void;
  copiedText: string | null;
  onRecordResult: (planId: string, result: RecordResultPayload) => Promise<void>;
}) => {
  return (
    <Card className={plan.status === 'concluido' ? 'opacity-70' : ''}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2" onClick={onToggle} role="button">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Target className="w-4 h-4 text-primary shrink-0" />
            <span className="text-xs font-bold truncate">{plan.customerName}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className={`text-[7px] ${plan.planType === 'estrategico' ? 'border-primary text-primary' : ''}`}>
              {plan.planType === 'estrategico' ? '⚡ Estratégico' : '📋 Essencial'}
            </Badge>
            <Badge className={`text-[8px] ${objectiveColors[plan.strategicObjective] || ''}`}>
              {getObjectiveLabel(plan.strategicObjective)}
            </Badge>
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </div>
        </div>

        {/* Quick metrics */}
        <div className="grid grid-cols-4 gap-1 text-center text-[9px]">
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{Math.round(plan.healthScore)}</p>
            <p className="text-muted-foreground">Health</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{Math.round(plan.churnRisk)}%</p>
            <p className="text-muted-foreground">Churn</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{plan.mixGap}</p>
            <p className="text-muted-foreground">Gap Mix</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{fmt(plan.bundleLie)}</p>
            <p className="text-muted-foreground">LIE</p>
          </div>
        </div>

        {/* Efficiency indicator */}
        {plan.estimatedProfitPerHour > 0 && (
          <div className={`mt-1.5 flex items-center gap-1 text-[9px] ${
            plan.estimatedProfitPerHour >= 50 ? 'text-status-success' : 'text-status-warning'
          }`}>
            <DollarSign className="w-3 h-3" />
            <span>Lucro estimado: {fmt(plan.estimatedProfitPerHour)}/h</span>
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="mt-3 space-y-3">
            {/* Diagnosis */}
            <Section title="Diagnóstico Resumido" icon={Heart}>
              <MetricRow label="Margem atual" value={`${plan.currentMarginPct.toFixed(1)}%`} />
              <MetricRow label="Média cluster" value={plan.clusterAvgMarginPct == null ? '—' : `${plan.clusterAvgMarginPct.toFixed(1)}%`} />
              <MetricRow label="Potencial expansão" value={`${plan.expansionPotential.toFixed(0)}%`} />
              <MetricRow label="Perfil" value={profileLabels[plan.customerProfile] || plan.customerProfile} />
            </Section>

            {/* LTV Projection (strategic only) */}
            {plan.ltvProjection && (
              <Section title="Projeção de LTV" icon={BarChart3}>
                <MetricRow label="Faturamento atual/ano" value={fmt(plan.ltvProjection.current_annual)} />
                <MetricRow label="Projetado/ano" value={fmt(plan.ltvProjection.projected_annual)} />
                <MetricRow label="Crescimento" value={`+${plan.ltvProjection.growth_pct}%`} />
              </Section>
            )}

            {/* Expected Result (strategic only) */}
            {plan.expectedResult && (
              <Section title="Simulação de Resultado" icon={TrendingUp}>
                <MetricRow label="Melhor cenário" value={fmt(plan.expectedResult.best_case_margin)} />
                <MetricRow label="Cenário provável" value={fmt(plan.expectedResult.likely_margin)} />
                <MetricRow label="Pior cenário" value={fmt(plan.expectedResult.worst_case_margin)} />
              </Section>
            )}

            {/* Strategy A */}
            {plan.approachStrategy && (
              <Section title="Estratégia de Abordagem A" icon={Brain}>
                <p className="text-xs leading-relaxed">{plan.approachStrategy}</p>
                <CopyButton text={plan.approachStrategy} copied={copiedText === plan.approachStrategy} onCopy={onCopy} />
              </Section>
            )}

            {/* Strategy B (strategic only) */}
            {plan.approachStrategyB && (
              <Section title="Estratégia Alternativa B" icon={Shield}>
                <p className="text-xs leading-relaxed">{plan.approachStrategyB}</p>
                <CopyButton text={plan.approachStrategyB} copied={copiedText === plan.approachStrategyB} onCopy={onCopy} />
              </Section>
            )}

            {/* Bundle */}
            {plan.bundleLie > 0 && (
              <Section title="Bundle Prioritário" icon={Package}>
                <MetricRow label="LIE Bundle" value={fmt(plan.bundleLie)} />
                <MetricRow label="Probabilidade" value={`${plan.bundleProbability.toFixed(1)}%`} />
                <MetricRow label="Margem incremental" value={fmt(plan.bundleIncrementalMargin)} />
                {plan.bestIndividualLie > 0 && (
                  <MetricRow label="Melhor individual" value={fmt(plan.bestIndividualLie)} />
                )}
              </Section>
            )}

            {/* Diagnostic Questions */}
            {plan.diagnosticQuestions.length > 0 && (
              <Section title="Perguntas Diagnósticas" icon={MessageSquare}>
                {plan.diagnosticQuestions.map((q, i) => (
                  <div key={i} className="p-2 rounded bg-muted/30 space-y-0.5">
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium">
                        <span className="text-primary">{i + 1}.</span> {q.question}
                      </p>
                      <CopyButton text={q.question} copied={copiedText === q.question} onCopy={onCopy} />
                    </div>
                    <p className="text-[9px] text-muted-foreground">💡 {q.purpose}</p>
                  </div>
                ))}

                {plan.implicationQuestion && (
                  <div className="p-2 rounded bg-status-warning-bg border border-status-warning/30">
                    <div className="flex items-start justify-between gap-1">
                      <div>
                        <p className="text-[9px] font-semibold text-status-warning">Pergunta de Implicação</p>
                        <p className="text-xs">{plan.implicationQuestion}</p>
                      </div>
                      <CopyButton text={plan.implicationQuestion} copied={copiedText === plan.implicationQuestion} onCopy={onCopy} />
                    </div>
                  </div>
                )}

                {plan.offerTransition && (
                  <div className="p-2 rounded bg-status-success-bg border border-status-success/30">
                    <div className="flex items-start justify-between gap-1">
                      <div>
                        <p className="text-[9px] font-semibold text-status-success">Transição para Oferta</p>
                        <p className="text-xs">{plan.offerTransition}</p>
                      </div>
                      <CopyButton text={plan.offerTransition} copied={copiedText === plan.offerTransition} onCopy={onCopy} />
                    </div>
                  </div>
                )}
              </Section>
            )}

            {/* Objections */}
            {plan.probableObjections.length > 0 && (
              <Section title="Mapa de Objeções" icon={Shield}>
                {plan.probableObjections.map((obj, i) => (
                  <div key={i} className="p-2 rounded bg-muted/30 space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-status-error">⚠ {obj.objection}</p>
                      <Badge variant="outline" className="text-[8px]">{obj.probability}%</Badge>
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-start gap-1">
                        <span className="text-[9px] font-semibold text-status-info shrink-0">Técnica:</span>
                        <p className="text-[10px]">{obj.technical_response}</p>
                      </div>
                      <div className="flex items-start gap-1">
                        <span className="text-[9px] font-semibold text-status-success shrink-0">Econômica:</span>
                        <p className="text-[10px]">{obj.economic_response}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {/* Operational Risks (strategic only) */}
            {plan.operationalRisks.length > 0 && (
              <Section title="Riscos Operacionais" icon={AlertTriangle}>
                {plan.operationalRisks.map((risk, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <AlertCircle className="w-3 h-3 text-status-warning shrink-0 mt-0.5" />
                    <span>{risk}</span>
                  </div>
                ))}
              </Section>
            )}

            {/* Post-call registration */}
            {plan.status !== 'concluido' && (
              <RecordResultDialog planId={plan.id} onRecord={onRecordResult} />
            )}

            {plan.status === 'concluido' && (
              <div className="p-2 rounded bg-muted/50 text-[10px] space-y-0.5">
                <p className="font-semibold">Resultado registrado</p>
                <p>Plano seguido: {plan.planFollowed ? 'Sim' : 'Não'}</p>
                <p>Resultado: {plan.callResult}</p>
                {plan.actualMargin !== undefined && <p>Margem: {fmt(plan.actualMargin)}</p>}
                {plan.callDurationSeconds && <p>Duração: {Math.round(plan.callDurationSeconds / 60)}min</p>}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
