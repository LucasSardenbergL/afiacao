// Fila de "SLA de contato vencido" da carteira — fecha o loop scoring → ação.
// Read-model puro sobre a view v_carteira_sla (nenhum writer novo).
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { useCarteiraSla } from '@/hooks/useCarteiraSla';
import { formatDiasSemContato } from '@/lib/carteira/interacoes';

const HEALTH_LABEL: Record<string, string> = {
  saudavel: 'Saudável',
  estavel: 'Estável',
  atencao: 'Atenção',
  critico: 'Crítico',
};

export function SlaVencidoCard({
  nomePorCliente,
  onClienteClick,
}: {
  /** customer_user_id → nome (vem do useFarmerScoring no pai; evita query extra). */
  nomePorCliente: Map<string, string>;
  onClienteClick?: (customerUserId: string) => void;
}) {
  const { data, isLoading } = useCarteiraSla();

  if (isLoading) {
    return <div className="h-32 rounded-lg bg-muted/40 animate-pulse" />;
  }

  const vencidos = (data ?? []).filter((r) => r.vencido);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-status-error" />
          SLA de contato vencido
          <Badge variant="outline" className="ml-auto text-[10px] uppercase font-tabular text-status-error">
            {vencidos.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {vencidos.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="Carteira em dia"
            description="Nenhum cliente com SLA de contato vencido."
            tone="operational"
          />
        ) : (
          <ul className="divide-y divide-border -my-1">
            {vencidos.slice(0, 20).map((r) => (
              <li key={r.customer_user_id}>
                <button
                  type="button"
                  onClick={() => onClienteClick?.(r.customer_user_id)}
                  className="w-full py-2 flex items-center justify-between gap-3 text-left text-sm hover:bg-muted/40 rounded px-1"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {nomePorCliente.get(r.customer_user_id) ?? 'Cliente sem nome'}
                    <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                      {HEALTH_LABEL[r.health_class] ?? r.health_class}
                    </span>
                  </span>
                  <span className="text-status-error text-xs font-medium shrink-0">
                    {formatDiasSemContato(r.dias_sem_contato)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
