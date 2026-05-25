// Card de transcrição da conversa (voz ou texto).
// Extraído verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { TranscriptEntry } from '@/hooks/useCopilotEngine';
import type { InputMode } from './types';

interface TranscriptCardProps {
  transcript: TranscriptEntry[];
  inputMode: InputMode;
  transcriptEndRef: React.RefObject<HTMLDivElement>;
}

export function TranscriptCard({ transcript, inputMode, transcriptEndRef }: TranscriptCardProps) {
  return (
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-xs flex items-center gap-2">
          <MessageSquare className="w-3 h-3" /> Transcrição
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-48 px-3 pb-3">
          {transcript.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-8">
              {inputMode === 'voice' ? 'Aguardando fala...' : 'Nenhum texto analisado ainda.'}
            </p>
          ) : (
            <div className="space-y-1">
              {transcript.map(entry => (
                <p
                  key={entry.id}
                  className={`text-xs leading-relaxed ${entry.isPartial ? 'text-muted-foreground italic' : ''}`}
                >
                  {entry.text}
                </p>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
