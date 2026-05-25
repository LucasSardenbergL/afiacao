// Card da sugestão da IA (com cópia e contadores).
// Extraído verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { Copy, Check, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CopilotAnalysis } from '@/hooks/useCopilotEngine';

interface SuggestionCardProps {
  analysis: CopilotAnalysis;
  SugIcon: LucideIcon;
  riskFlash: boolean;
  copied: boolean;
  onCopy: (text: string) => void;
  suggestionsShown: number;
  suggestionsUsed: number;
}

export function SuggestionCard({
  analysis,
  SugIcon,
  riskFlash,
  copied,
  onCopy,
  suggestionsShown,
  suggestionsUsed,
}: SuggestionCardProps) {
  return (
    <Card className={cn(
      'border-2 border-primary/30 bg-primary/5 transition-all duration-500',
      riskFlash && analysis.direction === 'risco' && 'ring-2 ring-red-400 shadow-lg shadow-red-100'
    )}>
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 flex-1">
            <SugIcon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="text-[10px] font-semibold text-primary mb-0.5">
                {analysis.suggestionType === 'pergunta_diagnostica' ? 'Pergunta Sugerida' :
                 analysis.suggestionType === 'resposta_tecnica' ? 'Resposta Técnica' :
                 analysis.suggestionType === 'argumento_economico' ? 'Argumento Econômico' :
                 'Abordagem Alternativa'}
              </p>
              <p className="text-xs leading-relaxed">{analysis.suggestion}</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 shrink-0"
            onClick={() => onCopy(analysis.suggestion)}
          >
            {copied ? <Check className="w-3 h-3 text-status-success" /> : <Copy className="w-3 h-3" />}
          </Button>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[9px] text-muted-foreground">
            Confiança: {analysis.confidence}%
          </span>
          <span className="text-[9px] text-muted-foreground">
            {suggestionsShown} sugestões • {suggestionsUsed} usadas
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
