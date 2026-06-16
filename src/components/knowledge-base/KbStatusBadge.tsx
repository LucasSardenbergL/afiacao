import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import type { KbDocumentStatus } from '@/lib/knowledge-base/types';

const COLOR: Record<KbDocumentStatus, string> = {
  processing: 'border-status-info text-status-info',
  ready: 'border-status-success text-status-success',
  error: 'border-status-error text-status-error',
  draft: 'border-muted-foreground/30 text-muted-foreground',
};

const LABEL: Record<KbDocumentStatus, string> = {
  processing: 'Processando',
  ready: 'Pronto',
  error: 'Erro',
  draft: 'Rascunho',
};

export function KbStatusBadge({ status }: { status: KbDocumentStatus }) {
  return (
    <Badge variant="outline" className={`text-2xs gap-1 ${COLOR[status]}`}>
      {status === 'processing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {LABEL[status]}
    </Badge>
  );
}
