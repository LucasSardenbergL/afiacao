import { useCompletude } from '@/hooks/useCompletude';
import { rotularCampo } from '@/lib/knowledge-base/campo-labels';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2 } from 'lucide-react';

/**
 * Aba "Dados faltantes" (Fase B1): produtos aprovados com campos importantes vazios,
 * do mais incompleto pro menos. Read-only — clica e vai pro detalhe do boletim.
 */
export function CompletudeSection() {
  const { data, isLoading } = useCompletude();

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card className="p-8 text-center text-xs text-muted-foreground">
        <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-status-success opacity-70" />
        Todas as fichas aprovadas estão completas nos dados importantes.
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-2xs text-muted-foreground">
        {data.length} produto{data.length > 1 ? 's' : ''} com dados importantes faltando — sua lista pra pedir à fábrica.
      </p>

      {data.map((p) => {
        const inner = (
          <Card className="p-3 hover:bg-muted/40 transition-colors">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{p.product_name}</div>
                <div className="text-2xs text-muted-foreground font-mono">{p.product_code}</div>
              </div>
              <Badge variant="outline" className="text-2xs shrink-0">{p.faltantes.length} faltando</Badge>
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {p.faltantes.map((c) => (
                <Badge key={c} variant="secondary" className="text-2xs font-normal">
                  {rotularCampo(c)}
                </Badge>
              ))}
            </div>
          </Card>
        );

        return p.document_id ? (
          <Link key={p.product_code} to={`/admin/knowledge-base/${p.document_id}`} className="block">
            {inner}
          </Link>
        ) : (
          <div key={p.product_code}>{inner}</div>
        );
      })}
    </div>
  );
}
