// Header do AI Ops (título + filtro de confiança + botão Executar Agente).
// Extraído verbatim de src/pages/AIops.tsx (god-component split).
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Brain, RefreshCw } from 'lucide-react';

interface AiOpsHeaderProps {
  confidenceFilter: string;
  onConfidenceChange: (v: string) => void;
  onRunAgent: () => void;
  isRunningAgent: boolean;
}

export function AiOpsHeader({ confidenceFilter, onConfidenceChange, onRunAgent, isRunningAgent }: AiOpsHeaderProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Brain className="w-6 h-6 text-primary" />
          AI Ops
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Inteligência operacional — decisões e recomendações automatizadas
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Select value={confidenceFilter} onValueChange={onConfidenceChange}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Confiança" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            <SelectItem value="alta">Alta</SelectItem>
            <SelectItem value="media">Média</SelectItem>
            <SelectItem value="baixa">Baixa</SelectItem>
          </SelectContent>
        </Select>
        <Button
          onClick={onRunAgent}
          disabled={isRunningAgent}
          variant="outline"
          className="gap-1.5"
        >
          <RefreshCw className={`w-4 h-4 ${isRunningAgent ? 'animate-spin' : ''}`} />
          Executar Agente
        </Button>
      </div>
    </div>
  );
}
