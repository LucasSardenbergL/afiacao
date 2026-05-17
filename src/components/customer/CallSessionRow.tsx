import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { MessageSquareText, Lightbulb, Tag } from 'lucide-react';
import type { CustomerCallRow } from '@/hooks/useCustomerCalls';

interface Props {
  call: CustomerCallRow;
  onClick: () => void;
}

export function CallSessionRow({ call, onClick }: Props) {
  const transcriptCount = Array.isArray(call.transcript) ? call.transcript.length : 0;
  const analysesCount = Array.isArray(call.analyses) ? call.analyses.length : 0;
  const entitiesCount = Array.isArray(call.entities_extracted) ? call.entities_extracted.length : 0;
  const durationMin = Math.floor((call.duration_seconds ?? 0) / 60);
  const revenue = Number(call.revenue_generated ?? 0);

  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center justify-between gap-3 rounded-md border border-border p-2.5 hover:bg-muted/40 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">
          {formatDistanceToNow(new Date(call.started_at), { locale: ptBR, addSuffix: true })}
        </div>
        <div className="text-2xs text-muted-foreground">
          {durationMin}min · {call.call_backend ?? 'manual'}{call.call_result && ` · ${call.call_result}`}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {transcriptCount > 0 && <Badge variant="outline" className="gap-1 text-2xs"><MessageSquareText className="w-2.5 h-2.5"/>{transcriptCount}</Badge>}
        {analysesCount > 0 && <Badge variant="outline" className="gap-1 text-2xs"><Lightbulb className="w-2.5 h-2.5"/>{analysesCount}</Badge>}
        {entitiesCount > 0 && <Badge variant="outline" className="gap-1 text-2xs"><Tag className="w-2.5 h-2.5"/>{entitiesCount}</Badge>}
        {revenue > 0 && <Badge variant="outline" className="text-2xs text-status-success border-status-success">R$ {revenue.toLocaleString('pt-BR')}</Badge>}
      </div>
    </button>
  );
}
