// Card de regra de associação (antecedente → consequente + métricas).
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split).
import { ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { AssociationRule } from '@/hooks/useBundleEngine';

export const RuleCard = ({ rule }: { rule: AssociationRule }) => (
  <Card>
    <CardContent className="p-2.5">
      <div className="flex items-center gap-1 mb-1 flex-wrap">
        {rule.antecedentNames.map((n, i) => <Badge key={i} variant="outline" className="text-[8px]">{n}</Badge>)}
        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
        {rule.consequentNames.map((n, i) => <Badge key={i} className="text-[8px] bg-status-success-bg text-status-success-fg">{n}</Badge>)}
      </div>
      <div className="flex gap-3 text-[9px]">
        <span>Sup: <strong>{(rule.support * 100).toFixed(1)}%</strong></span>
        <span>Conf: <strong>{(rule.confidence * 100).toFixed(1)}%</strong></span>
        <span>Lift: <strong>{rule.lift.toFixed(2)}</strong></span>
        <Badge variant="outline" className="text-[7px]">{rule.type === 'sequential' ? '⏱ Sequencial' : '🔗 Associação'}</Badge>
      </div>
    </CardContent>
  </Card>
);
