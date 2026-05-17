import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { KbStatusBadge } from '@/components/knowledge-base/KbStatusBadge';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Loader2 } from 'lucide-react';
import type { KbDocument } from '@/lib/knowledge-base/types';

export default function AdminKnowledgeBaseDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading } = useQuery({
    queryKey: ['kb-document', id],
    enabled: !!id,
    queryFn: async (): Promise<KbDocument | null> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('kb_documents') as any)
        .select('*')
        .eq('id', id!)
        .single();
      if (error) throw error;
      return data as KbDocument;
    },
    // polling enquanto processa
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 3000 : false),
  });

  const { data: chunkCount } = useQuery({
    queryKey: ['kb-chunks-count', id],
    enabled: !!id,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase.from('kb_chunks') as any)
        .select('*', { count: 'exact', head: true })
        .eq('document_id', id);
      return count ?? 0;
    },
  });

  if (isLoading) {
    return (
      <div className="container mx-auto p-4 flex justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="container mx-auto p-4 text-xs text-muted-foreground">
        Documento não encontrado
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 space-y-3 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold">{data.title}</h1>
        <KbStatusBadge status={data.status} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="text-2xs">{data.type}</Badge>
        {data.supplier && <Badge variant="outline" className="text-2xs">{data.supplier}</Badge>}
        {data.product_code && <Badge variant="outline" className="text-2xs">{data.product_code}</Badge>}
        {data.tags.map((t) => (
          <Badge key={t} variant="outline" className="text-2xs">
            {t}
          </Badge>
        ))}
      </div>
      <div className="text-2xs text-muted-foreground">
        Enviado {format(new Date(data.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
        {data.file_size_bytes && <> · {(data.file_size_bytes / 1024).toFixed(0)} KB</>}
        {chunkCount !== undefined && <> · {chunkCount} chunks indexados</>}
      </div>

      {data.status === 'error' && data.status_error && (
        <Card className="p-3 border-status-error bg-status-error-bg/50">
          <div className="text-xs font-medium text-status-error">Erro no processamento</div>
          <div className="text-2xs text-muted-foreground font-mono mt-1">{data.status_error}</div>
        </Card>
      )}

      {data.content_extracted && (
        <Card className="p-3">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground mb-2">
            Texto extraído
          </div>
          <pre className="text-xs whitespace-pre-wrap font-sans text-foreground/80 max-h-96 overflow-y-auto">
            {data.content_extracted}
          </pre>
        </Card>
      )}
    </div>
  );
}
