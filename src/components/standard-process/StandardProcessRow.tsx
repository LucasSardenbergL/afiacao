import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StandardProcessStatusBadge } from './StandardProcessStatusBadge';
import { Factory } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { StandardProcess } from '@/lib/standard-process/types';

export function StandardProcessRow({ process }: { process: StandardProcess }) {
  return (
    <Link to={`/admin/standard-processes/${process.id}`}>
      <Card className="p-3 hover:bg-muted/40 transition-colors flex items-center gap-3">
        <Factory className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{process.name}</span>
            <Badge variant="outline" className="text-2xs">{process.segmento}</Badge>
            <StandardProcessStatusBadge status={process.status} />
          </div>
          <div className="text-2xs text-muted-foreground mt-0.5">
            {process.porte_alvo.length > 0 && <>portes: {process.porte_alvo.join(', ')} · </>}
            {process.etapas.length} etapas · atualizado {formatDistanceToNow(new Date(process.updated_at), { locale: ptBR, addSuffix: true })}
            {process.tags.length > 0 && <> · {process.tags.slice(0, 3).join(' · ')}</>}
          </div>
        </div>
      </Card>
    </Link>
  );
}
