// Indicador de direção da conversa (positivo/neutro/risco) + intenção + fase.
// Extraído verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { CopilotAnalysis } from '@/hooks/useCopilotEngine';
import { intentLabels, phaseLabels } from './config';

interface DirectionIndicatorProps {
  analysis: CopilotAnalysis;
  dir: { color: string; bg: string; icon: LucideIcon; label: string };
  DirIcon: LucideIcon;
}

export function DirectionIndicator({ analysis, dir, DirIcon }: DirectionIndicatorProps) {
  return (
    <Card className={`border ${dir.bg}`}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <DirIcon className={`w-5 h-5 ${dir.color}`} />
            <span className={`text-sm font-bold ${dir.color}`}>{dir.label}</span>
          </div>
          <div className="flex gap-1">
            <Badge className={intentLabels[analysis.intent]?.color || ''} variant="secondary">
              {intentLabels[analysis.intent]?.label || analysis.intent}
            </Badge>
            <Badge variant="outline" className="text-[9px]">
              {phaseLabels[analysis.phase] || analysis.phase}
            </Badge>
          </div>
        </div>
        {analysis.directionReasons.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {analysis.directionReasons.map((r, i) => (
              <span key={i} className="text-[9px] text-muted-foreground">• {r}</span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
