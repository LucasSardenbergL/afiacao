// Card de histórico de análises da sessão.
// Extraído verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { Brain } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CopilotAnalysis } from '@/hooks/useCopilotEngine';
import { intentLabels } from './config';

interface AnalysisHistoryCardProps {
  analysisHistory: CopilotAnalysis[];
}

export function AnalysisHistoryCard({ analysisHistory }: AnalysisHistoryCardProps) {
  return (
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-xs flex items-center gap-2">
          <Brain className="w-3 h-3" /> Histórico de Análises ({analysisHistory.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="space-y-1.5">
          {analysisHistory.slice(-5).reverse().map((a, i) => {
            return (
              <div key={i} className="flex items-center gap-2 text-[9px]">
                <div className={`w-2 h-2 rounded-full ${
                  a.direction === 'positivo' ? 'bg-status-success' :
                  a.direction === 'risco' ? 'bg-status-error' : 'bg-status-warning'
                }`} />
                <span className="font-medium">{intentLabels[a.intent]?.label}</span>
                <span className="text-muted-foreground">→</span>
                <span className="text-muted-foreground truncate flex-1">{a.suggestion.slice(0, 50)}...</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
