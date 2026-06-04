import { ShoppingCart, MapPin, Phone, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useCustomerLastSalesOrder } from '@/hooks/useCustomerLastSalesOrder';
import { useCustomerVisits } from '@/hooks/useCustomerVisits';
import { useCustomerCalls } from '@/hooks/useCustomerCalls';
import { recenciaLabel } from '@/lib/visitas/recencia';
import { visitResultLabel } from '@/lib/visitas/visit-result';
import { formatBRL } from '@/components/customer360/format';

const toneClass: Record<string, string> = {
  success: 'text-status-success',
  info: 'text-status-info',
  error: 'text-status-error',
  warning: 'text-status-warning',
  muted: 'text-muted-foreground',
};

/**
 * Brief pré-visita: 3 facts de recência consolidadas (última compra / visita / ligação).
 * Read-only, self-contained (reusa 3 hooks por customerId). Sem backend.
 */
export function CustomerBrief({ customerId }: { customerId: string }) {
  const order = useCustomerLastSalesOrder(customerId);
  const visits = useCustomerVisits(customerId);
  const calls = useCustomerCalls(customerId);
  const hoje = new Date().toISOString().slice(0, 10);

  const loading = order.isLoading || visits.isLoading || calls.isLoading;
  const lastOrder = order.data;
  const lastVisit = visits.data?.[0];
  const lastCall = calls.data?.[0];
  const vr = lastVisit ? visitResultLabel(lastVisit.result) : null;

  return (
    <Card className="p-3">
      <div className="text-xs font-medium text-muted-foreground mb-2">Resumo pré-visita</div>
      {loading ? (
        <div className="flex items-center text-xs text-muted-foreground py-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />Carregando…
        </div>
      ) : (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Última compra:</span>
            <span className="font-medium">
              {lastOrder ? recenciaLabel(lastOrder.date, hoje) : 'nunca comprou'}
              {lastOrder && (lastOrder.total ?? 0) > 0 && (
                <span className="text-muted-foreground font-normal"> · {formatBRL(lastOrder.total)}</span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Última visita:</span>
            {lastVisit && vr ? (
              <span className="font-medium">
                {recenciaLabel(lastVisit.check_in_at, hoje)}{' '}
                <span className={toneClass[vr.tone]}>· {vr.emoji} {vr.label}</span>
              </span>
            ) : (
              <span className="font-medium text-muted-foreground">nenhuma</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Última ligação:</span>
            {lastCall ? (
              <span className="font-medium">
                {recenciaLabel(lastCall.started_at, hoje)}
                {lastCall.call_result && (
                  <span className="text-muted-foreground font-normal"> · {lastCall.call_result}</span>
                )}
              </span>
            ) : (
              <span className="font-medium text-muted-foreground">nenhuma</span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
