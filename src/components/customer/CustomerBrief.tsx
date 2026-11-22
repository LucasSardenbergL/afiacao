import { ShoppingCart, MapPin, Phone, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useCustomerLastSalesOrder } from '@/hooks/useCustomerLastSalesOrder';
import { useCustomerVisits } from '@/hooks/useCustomerVisits';
import { useCustomerLastCall } from '@/hooks/useCustomerCalls';
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

/** Estado de UMA fonte do resumo: cada linha fala por si (uma falha não apaga as outras). */
export type EstadoFonteBrief = 'carregando' | 'falha' | 'ok';
export function estadoFonteBrief(q: { isPending: boolean; isError: boolean; data?: unknown }): EstadoFonteBrief {
  // Dado em cache com refetch falho continua valendo (é a última leitura bem-sucedida).
  if (q.data !== undefined) return 'ok';
  if (q.isError) return 'falha';
  return q.isPending ? 'carregando' : 'ok';
}

const INDISPONIVEL = 'indisponível';

function Pendente({ estado }: { estado: Exclude<EstadoFonteBrief, 'ok'> }) {
  return estado === 'carregando' ? (
    <span className="inline-flex items-center text-xs text-muted-foreground">
      <Loader2 className="w-3 h-3 animate-spin mr-1.5" aria-hidden />carregando…
    </span>
  ) : (
    <span className="font-medium text-status-warning" title="A leitura falhou — não dá pra afirmar que não há registro.">
      {INDISPONIVEL}
    </span>
  );
}

/**
 * Brief pré-visita: 3 facts de recência consolidadas (última compra / visita / ligação).
 * Read-only, self-contained (3 hooks por customerId). Cada fonte tem estado PRÓPRIO: "nunca
 * comprou"/"nenhuma" só com a leitura bem-sucedida; falha → "indisponível" (ausente ≠ vazio).
 */
export function CustomerBrief({ customerId }: { customerId: string }) {
  const order = useCustomerLastSalesOrder(customerId);
  const visits = useCustomerVisits(customerId);
  const calls = useCustomerLastCall(customerId);
  const hoje = new Date().toISOString().slice(0, 10);

  const estadoPedido = estadoFonteBrief(order);
  const estadoVisita = estadoFonteBrief(visits);
  const estadoLigacao = estadoFonteBrief(calls);
  const lastOrder = order.data;
  const lastVisit = visits.data?.[0];
  const lastCall = calls.data;
  const vr = lastVisit ? visitResultLabel(lastVisit.result) : null;

  return (
    <Card className="p-3">
      <div className="text-xs font-medium text-muted-foreground mb-2">Resumo pré-visita</div>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-2">
          <ShoppingCart className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Última compra:</span>
          {estadoPedido !== 'ok' ? <Pendente estado={estadoPedido} /> : (
            <span className="font-medium">
              {lastOrder ? recenciaLabel(lastOrder.date, hoje) : 'nunca comprou'}
              {lastOrder && lastOrder.total != null && lastOrder.total > 0 && (
                <span className="text-muted-foreground font-normal"> · {formatBRL(lastOrder.total)}</span>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Última visita:</span>
          {estadoVisita !== 'ok' ? <Pendente estado={estadoVisita} /> : lastVisit && vr ? (
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
          {estadoLigacao !== 'ok' ? <Pendente estado={estadoLigacao} /> : lastCall ? (
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
    </Card>
  );
}
