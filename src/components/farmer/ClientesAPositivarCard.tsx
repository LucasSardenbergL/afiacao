import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { track } from '@/lib/analytics';
import type { ClienteAPositivar } from '@/lib/positivacao/types';

export function ClientesAPositivarCard({ clientes }: { clientes: ClienteAPositivar[] }) {
  if (clientes.length === 0) {
    return (
      <Card className="p-6 text-2xs text-muted-foreground">
        Toda a carteira elegível já comprou este mês. 🎯
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Clientes a positivar</h2>
        <p className="text-2xs text-muted-foreground">
          {clientes.length} clientes da sua carteira ainda sem pedido este mês — ordenados por prioridade
        </p>
      </CardHeader>
      <div className="divide-y divide-border">
        {clientes.slice(0, 30).map((c) => (
          <Link
            key={c.customer_user_id}
            to={`/admin/customers/${c.customer_user_id}/360`}
            onClick={() => track('carteira.a_positivar_cliente_aberto', {
              dias_sem_comprar: c.days_since_last_purchase,
              churn_alto: (c.churn_risk ?? 0) >= 60,
            })}
            className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{c.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground flex gap-2 flex-wrap">
                {c.days_since_last_purchase != null && <span>{c.days_since_last_purchase}d sem comprar</span>}
                {(c.churn_risk ?? 0) >= 60 && (
                  <Badge variant="outline" className="text-status-error text-2xs">churn alto</Badge>
                )}
              </div>
            </div>
            {c.revenue_potential != null && c.revenue_potential > 0 && (
              <div className="text-2xs text-muted-foreground font-tabular shrink-0">
                pot. R$ {Math.round(c.revenue_potential).toLocaleString('pt-BR')}
              </div>
            )}
          </Link>
        ))}
      </div>
    </Card>
  );
}
