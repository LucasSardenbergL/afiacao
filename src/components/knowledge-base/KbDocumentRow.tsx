import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { KbStatusBadge } from './KbStatusBadge';
import { FileText } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { KB_DOCUMENT_TYPE_LABEL, type KbDocument } from '@/lib/knowledge-base/types';

export function KbDocumentRow({ doc }: { doc: KbDocument }) {
  return (
    <Link to={`/admin/knowledge-base/${doc.id}`}>
      <Card className="p-3 hover:bg-muted/40 transition-colors flex items-center gap-3">
        <FileText className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{doc.title}</span>
            <Badge variant="outline" className="text-2xs">{KB_DOCUMENT_TYPE_LABEL[doc.type]}</Badge>
            {doc.supplier && <Badge variant="outline" className="text-2xs">{doc.supplier}</Badge>}
            <KbStatusBadge status={doc.status} />
          </div>
          <div className="text-2xs text-muted-foreground mt-0.5">
            {doc.product_code && <>{doc.product_code} · </>}
            {formatDistanceToNow(new Date(doc.created_at), { locale: ptBR, addSuffix: true })}
            {doc.tags.length > 0 && <> · {doc.tags.join(', ')}</>}
          </div>
        </div>
      </Card>
    </Link>
  );
}
