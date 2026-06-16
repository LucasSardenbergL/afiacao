// Entrada manual de texto (modo texto do copiloto).
// Extraído verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { Type, Send, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ManualTextInputProps {
  manualText: string;
  setManualText: (v: string) => void;
  isManualAnalyzing: boolean;
  onAnalyze: () => void;
}

export function ManualTextInput({ manualText, setManualText, isManualAnalyzing, onAnalyze }: ManualTextInputProps) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Type className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[10px] font-semibold text-muted-foreground">Entrada de texto</span>
        </div>
        <Textarea
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          placeholder="Cole ou digite trechos da conversa aqui..."
          className="text-xs min-h-[80px] resize-none"
        />
        <Button
          size="sm"
          className="w-full h-8 gap-1.5 text-xs"
          disabled={isManualAnalyzing || !manualText.trim()}
          onClick={onAnalyze}
        >
          {isManualAnalyzing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Send className="w-3 h-3" />
          )}
          Analisar
        </Button>
      </CardContent>
    </Card>
  );
}
