import { Card } from '@/components/ui/card';
import { Phone, PhoneIncoming, UserPlus, Construction } from 'lucide-react';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';

/**
 * Dashboard Hunter — placeholder rico até PR-MULTIVENDOR-V2 implementar
 * pipeline kanban + métricas reais.
 */
export function HunterDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Hunter (inbound)</h1>
        <p className="text-xs text-muted-foreground">
          Foco em chamadas que chegam de clientes novos e qualificação rápida pra entregar pro Closer ou fechar direto.
        </p>
      </div>

      <MinhasTarefasCard />

      <Card className="p-4 border-dashed border-2 border-status-warning/30 bg-status-warning-bg/20">
        <div className="flex items-center gap-2 mb-2">
          <Construction className="w-4 h-4 text-status-warning" />
          <span className="text-sm font-medium">Em construção — PR-MULTIVENDOR-V2</span>
        </div>
        <p className="text-2xs text-muted-foreground">Próximas features:</p>
        <ul className="text-2xs text-muted-foreground space-y-1 mt-2 ml-4 list-disc">
          <li>Pipeline kanban (lead novo → contactado → qualificado → entregue ao Closer)</li>
          <li>Taxa de qualificação + motivos de descarte</li>
          <li>Cadência de follow-up automática (D+1, D+3, D+7)</li>
          <li>Botão &quot;Encaminhar pro Closer&quot; com contexto (transcript, captura, ProcessComparisonPanel)</li>
          <li>Métricas: dials/dia, conexões, SQLs entregues</li>
        </ul>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <PhoneIncoming className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Chamadas hoje
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <UserPlus className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Prospects criados
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Phone className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Entregues ao Closer
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
      </div>
    </div>
  );
}
