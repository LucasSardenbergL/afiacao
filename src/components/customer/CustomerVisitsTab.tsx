import { Loader2 } from 'lucide-react';
import { useCustomerVisits } from '@/hooks/useCustomerVisits';
import { visitResultLabel, resumoVisitas } from '@/lib/visitas/visit-result';
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';

const toneClass: Record<string, string> = {
  success: 'text-status-success',
  info: 'text-status-info',
  error: 'text-status-error',
  warning: 'text-status-warning',
  muted: 'text-muted-foreground',
};

export function CustomerVisitsTab({ customerId }: { customerId: string }) {
  const { data, isLoading } = useCustomerVisits(customerId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />Carregando…
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-xs text-muted-foreground">
        Nenhuma visita registrada. As visitas com check-out no planejador de rotas aparecem aqui.
      </div>
    );
  }

  const resumo = resumoVisitas(data);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground border-b pb-2">
        <span><strong className="text-foreground">{resumo.total}</strong> visita{resumo.total > 1 ? 's' : ''}</span>
        <span>Conversão: <strong className="text-foreground">{formatarFracaoPct(resumo.taxaConversao)}</strong></span>
        <span>Receita: <strong className="text-foreground">{formatBRL(resumo.receitaTotal)}</strong></span>
      </div>

      <div className="space-y-2">
        {data.map((v) => {
          const r = visitResultLabel(v.result);
          const dia = v.check_in_at ? new Date(v.check_in_at).toLocaleDateString('pt-BR') : v.visit_date;
          return (
            <div key={v.id} className="border rounded-md p-2.5 text-sm space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`font-medium ${toneClass[r.tone]}`}>{r.emoji} {r.label}</span>
                <span className="text-xs text-muted-foreground font-tabular">{dia}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">por {v.visitedByName}</span>
                {v.result === 'pedido_fechado' && (v.revenue_generated ?? 0) > 0 && (
                  <span className="text-status-success font-medium">{formatBRL(v.revenue_generated)}</span>
                )}
              </div>
              {v.notes && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{v.notes}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
