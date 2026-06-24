// Fila de "SLA de contato vencido" da carteira — fecha o loop scoring → ação.
// Read-model puro sobre a view v_carteira_sla (nenhum writer novo).
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
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
  /** customer_user_id → nome (vem do useFarmerScoring; cobre a carteira do próprio vendedor sem query). */
  nomePorCliente: Map<string, string>;
  onClienteClick?: (customerUserId: string) => void;
}) {
  const { data, isLoading } = useCarteiraSla();
  const vencidos = (data ?? []).filter((r) => r.vencido);

  // Para o gestor a fila pode trazer clientes fora do scoring corrente → resolve os nomes
  // faltantes via profiles (evita exibir UUID). Só dispara se houver ids faltando.
  const idsFaltantes = vencidos
    .map((r) => r.customer_user_id)
    .filter((id) => !nomePorCliente.has(id));
  const { data: nomesExtra } = useQuery({
    queryKey: ['sla-nomes-faltantes', [...idsFaltantes].sort().join(',')],
    enabled: idsFaltantes.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: ps } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', idsFaltantes);
      return new Map((ps ?? []).map((p) => [p.user_id, p.name ?? '']));
    },
  });

  const nomeDe = (id: string) => nomePorCliente.get(id) || nomesExtra?.get(id) || 'Cliente sem nome';

  if (isLoading) {
    return <div className="h-32 rounded-lg bg-muted/40 animate-pulse" />;
  }

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
                    {nomeDe(r.customer_user_id)}
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
