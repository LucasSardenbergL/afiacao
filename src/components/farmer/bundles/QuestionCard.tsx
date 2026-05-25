// Card de pergunta diagnóstica SPIN (resposta + notas + variação).
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { RotateCcw, ThumbsUp, ThumbsDown, Minus } from 'lucide-react';
import { typeLabels, type QuestionWithResponse, type QuestionResponse } from '@/hooks/useDiagnosticQuestions';

export const QuestionCard = ({ question, onSetResponse, onToggleAlt }: {
  question: QuestionWithResponse;
  onSetResponse: (resp: QuestionResponse, notes?: string) => void;
  onToggleAlt: () => void;
}) => {
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(question.notes || '');
  const info = typeLabels[question.type] || { label: question.type, emoji: '❓', color: 'text-foreground' };
  const displayText = question.useAlt ? question.alt : question.main;

  const responseIcons: Record<QuestionResponse, { icon: typeof ThumbsUp; label: string; color: string }> = {
    interesse: { icon: ThumbsUp, label: 'Interesse', color: 'bg-status-success-bg text-status-success border-status-success/30' },
    objecao: { icon: ThumbsDown, label: 'Objeção', color: 'bg-status-error-bg text-status-error border-status-error/30' },
    indiferenca: { icon: Minus, label: 'Indiferença', color: 'bg-muted text-muted-foreground border-border' },
  };

  return (
    <div className="border rounded-lg p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{info.emoji}</span>
          <span className={`text-[9px] font-bold uppercase ${info.color}`}>{info.label}</span>
        </div>
        <Button size="sm" variant="ghost" className="h-5 text-[8px] px-1.5 gap-0.5" onClick={onToggleAlt} title="Alternar variação">
          <RotateCcw className="w-2.5 h-2.5" /> Alt
        </Button>
      </div>

      <p className="text-[10px] leading-relaxed font-medium">"{displayText}"</p>
      <p className="text-[8px] text-muted-foreground italic">💡 {question.rationale}</p>

      {/* Response buttons */}
      <div className="flex items-center gap-1">
        {(Object.entries(responseIcons) as [QuestionResponse, typeof responseIcons[QuestionResponse]][]).map(([key, val]) => {
          const Icon = val.icon;
          const isActive = question.response === key;
          return (
            <Button
              key={key}
              size="sm"
              variant="outline"
              className={`h-6 text-[8px] gap-0.5 px-2 ${isActive ? val.color + ' border' : ''}`}
              onClick={() => {
                onSetResponse(key, notes);
                if (!showNotes) setShowNotes(true);
              }}
            >
              <Icon className="w-2.5 h-2.5" /> {val.label}
            </Button>
          );
        })}
      </div>

      {/* Notes */}
      {showNotes && (
        <Textarea
          placeholder="Notas da resposta..."
          className="text-[10px] h-12 resize-none"
          value={notes}
          onChange={e => {
            setNotes(e.target.value);
            onSetResponse(question.response || 'indiferenca', e.target.value);
          }}
        />
      )}
    </div>
  );
};
