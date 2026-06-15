import { useSpecVersions } from '@/hooks/useSpecVersions';
import { diffVersions, type DiffTipo } from '@/lib/knowledge-base/version-diff';
import { rotularCampo, formatarValorCampo, rotularChangeType } from '@/lib/knowledge-base/campo-labels';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { History } from 'lucide-react';

const COR: Record<DiffTipo, string> = {
  added: 'text-status-success',
  removed: 'text-status-error',
  changed: 'text-status-warning',
};
const SIMBOLO: Record<DiffTipo, string> = { added: '+', removed: '−', changed: '~' };

/**
 * Linha do tempo das versões de um produto (Fase B1). Cada versão ≥ v2 mostra o diff
 * vs a imediatamente anterior. Read-only. Retorna null quando o produto não tem versões
 * (ex.: ficha ainda não aprovada).
 */
export function VersionHistory({
  supplier,
  productCode,
}: {
  supplier: string | null | undefined;
  productCode: string | null | undefined;
}) {
  const { data: versions } = useSpecVersions(supplier, productCode);
  if (!versions || versions.length === 0) return null;

  // versions vem DESC; pra o diff de cada uma preciso da versão de número imediatamente menor.
  const byNum = new Map(versions.map((v) => [v.version_number, v]));

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <History className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">Histórico de versões</span>
        <Badge variant="outline" className="text-2xs">{versions.length}</Badge>
      </div>

      <div className="space-y-3">
        {versions.map((v) => {
          const anterior = byNum.get(v.version_number - 1);
          const diff = anterior ? diffVersions(anterior, v) : [];
          return (
            <div key={v.id} className="border-l-2 border-border pl-3 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold tabular-nums">v{v.version_number}</span>
                <Badge variant="secondary" className="text-2xs">{rotularChangeType(v.change_type)}</Badge>
                <span className="text-2xs text-muted-foreground">
                  {format(new Date(v.approved_at), 'dd/MM/yyyy', { locale: ptBR })}
                </span>
              </div>

              {v.change_note && (
                <p className="text-2xs text-muted-foreground italic">"{v.change_note}"</p>
              )}

              {anterior && diff.length === 0 && (
                <p className="text-2xs text-muted-foreground">Sem mudanças nos campos técnicos.</p>
              )}

              {diff.length > 0 && (
                <ul className="space-y-0.5">
                  {diff.map((d) => (
                    <li key={d.campo} className="flex items-baseline gap-1.5 text-2xs">
                      <span className={`${COR[d.tipo]} font-bold w-3 shrink-0 tabular-nums`}>{SIMBOLO[d.tipo]}</span>
                      <span className="font-medium">{rotularCampo(d.campo)}:</span>
                      <span className="text-muted-foreground">
                        {formatarValorCampo(d.de)} <span className="opacity-50">→</span> {formatarValorCampo(d.para)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
