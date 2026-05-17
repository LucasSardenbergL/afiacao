import { useAuditTrail, type AuditEntry } from '@/hooks/useAuditTrail';
import { formatAuditDiff, formatAuditOrigem, formatAuditValue } from '@/lib/financeiro/audit';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableName: string;
  rowId: string;
  title?: string;
};

const ORIGEM_VARIANT: Record<AuditEntry['origem'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  manual: 'default',
  omie_sync: 'secondary',
  edge_fn: 'secondary',
  override_emergencia: 'destructive',
  cron: 'outline',
  trigger: 'outline',
};

export function AuditTrailDrawer({ open, onOpenChange, tableName, rowId, title }: Props) {
  const { data, isLoading, error } = useAuditTrail({ tableName, rowId });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{title ?? 'Histórico de alterações'}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {tableName} · {rowId}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {isLoading && (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </>
          )}

          {error && (
            <div className="text-status-error text-sm">
              Falha ao carregar histórico: {String((error as Error).message ?? error)}
            </div>
          )}

          {!isLoading && data?.length === 0 && (
            <div className="text-muted-foreground text-sm">Sem alterações registradas.</div>
          )}

          {data?.map(entry => {
            const diff = formatAuditDiff(entry.op, entry.changed_fields);
            return (
              <div key={entry.id} className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant={ORIGEM_VARIANT[entry.origem]}>{formatAuditOrigem(entry.origem)}</Badge>
                    <span className="font-mono">{entry.op}</span>
                  </div>
                  <span className="text-muted-foreground tabular-nums">
                    {format(new Date(entry.changed_at), 'dd/MM/yyyy HH:mm:ss')}
                  </span>
                </div>

                {entry.override_justificativa && (
                  <div className="rounded bg-status-warning-bg p-2 text-xs opacity-40">
                    <strong>Justificativa:</strong> {entry.override_justificativa}
                  </div>
                )}

                <ul className="text-sm space-y-1">
                  {diff.map(row => (
                    <li key={row.field} className="grid grid-cols-[140px_1fr] gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.field}</span>
                      <span>
                        {entry.op === 'UPDATE' ? (
                          <>
                            <span className="line-through text-muted-foreground">{formatAuditValue(row.before)}</span>
                            {' → '}
                            <span>{formatAuditValue(row.after)}</span>
                          </>
                        ) : entry.op === 'INSERT' ? (
                          <span>{formatAuditValue(row.after)}</span>
                        ) : (
                          <span className="line-through">{formatAuditValue(row.before)}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
