// Card do PTPL (plano tático) ativo durante a sessão.
// Extraído verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getObjectiveLabel, type TacticalPlan } from '@/hooks/useTacticalPlan';

interface ActivePlanCardProps {
  activePlan: TacticalPlan;
  showPlan: boolean;
  onToggle: () => void;
}

export function ActivePlanCard({ activePlan, showPlan, onToggle }: ActivePlanCardProps) {
  return (
    <Card className="border-dashed border-primary/30">
      <CardContent className="p-3">
        <div className="flex items-center justify-between" onClick={onToggle} role="button">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] font-semibold">PTPL Ativo — {activePlan.planType === 'estrategico' ? 'Estratégico' : 'Essencial'}</span>
          </div>
          {showPlan ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </div>
        {showPlan && (
          <div className="mt-2 space-y-1.5 text-[9px]">
            <div className="flex gap-1.5">
              <Badge variant="outline" className="text-[7px]">{getObjectiveLabel(activePlan.strategicObjective)}</Badge>
              <Badge variant="outline" className="text-[7px]">HS: {Math.round(activePlan.healthScore)}</Badge>
              <Badge variant="outline" className="text-[7px]">Churn: {Math.round(activePlan.churnRisk)}%</Badge>
            </div>
            {activePlan.approachStrategy && (
              <p className="text-muted-foreground">{activePlan.approachStrategy}</p>
            )}
            {activePlan.diagnosticQuestions.slice(0, 2).map((q, i) => (
              <p key={i} className="text-muted-foreground">• {q.question}</p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
