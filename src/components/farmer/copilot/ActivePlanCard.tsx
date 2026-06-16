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

function nomesDoBundle(b: Record<string, unknown> | undefined): string[] {
  const prods = (b?.bundle_products ?? b?.products) as Array<{ name?: string; nome?: string; descricao?: string }> | undefined;
  return Array.isArray(prods) ? prods.map((p) => p.name || p.nome || p.descricao || '').filter(Boolean) : [];
}

export function ActivePlanCard({ activePlan, showPlan, onToggle }: ActivePlanCardProps) {
  const produtos = nomesDoBundle(activePlan.topBundle);
  const temOferta = produtos.length > 0 || !!activePlan.offerTransition;

  return (
    <Card className="border-dashed border-primary/30">
      <CardContent className="p-3 space-y-2">
        {temOferta && (
          <div className="space-y-1">
            {produtos.length > 0 && (
              <p className="text-[11px] font-semibold leading-tight">💡 Ofereça: {produtos.join(' + ')}</p>
            )}
            {activePlan.offerTransition && (
              <p className="text-[10px] text-muted-foreground italic">"{activePlan.offerTransition}"</p>
            )}
            <div className="flex gap-1.5">
              {activePlan.bundleIncrementalMargin > 0 && (
                <Badge variant="outline" className="text-[7px]">+R$ {Math.round(activePlan.bundleIncrementalMargin)}/mês</Badge>
              )}
              {activePlan.bundleProbability > 0 && (
                <Badge variant="outline" className="text-[7px]">{Math.round(activePlan.bundleProbability * 100)}% aceite</Badge>
              )}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between" onClick={onToggle} role="button">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] font-semibold">Tática — {activePlan.planType === 'estrategico' ? 'Estratégico' : 'Essencial'}</span>
          </div>
          {showPlan ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </div>
        {showPlan && (
          <div className="space-y-1.5 text-[9px]">
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
