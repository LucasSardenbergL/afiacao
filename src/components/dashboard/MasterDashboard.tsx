import { Card } from '@/components/ui/card';
import { Construction, BarChart3, Users, Briefcase } from 'lucide-react';
import { KpisToday } from './KpisToday';
import { VisitSuggestionsCard } from './VisitSuggestionsCard';
import { ViewAsPicker } from '@/components/impersonation/ViewAsPicker';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';

/**
 * Dashboard Master (CEO) — visão consolidada do time + KPIs próprios (você
 * também é Closer). Placeholder rico até PR-MULTIVENDOR-V2 implementar ranking
 * de vendedores + métricas agregadas.
 */
export function MasterDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Master (CEO)</h1>
        <p className="text-xs text-muted-foreground">
          Visão consolidada do time. KPIs agregados, ranking de vendedores, alertas estratégicos.
        </p>
      </div>

      {/* Sugestões de visita — PR-VISIT-INTELLIGENCE Sub-PR A */}
      <VisitSuggestionsCard />

      {/* Ver como — master entra na visão de um vendedor (somente leitura) */}
      <ViewAsPicker />

      {/* Tarefas do vendedor sendo visto via "Ver como" (somente leitura; some sem impersonação) */}
      <MinhasTarefasCard />

      <Card className="p-4 border-dashed border-2 border-status-warning/30 bg-status-warning-bg/20">
        <div className="flex items-center gap-2 mb-2">
          <Construction className="w-4 h-4 text-status-warning" />
          <span className="text-sm font-medium">Em construção — PR-MULTIVENDOR-V2</span>
        </div>
        <p className="text-2xs text-muted-foreground">Próximas features:</p>
        <ul className="text-2xs text-muted-foreground space-y-1 mt-2 ml-4 list-disc">
          <li>Ranking de vendedores (chamadas/dia, R$ gerado, ticket médio, NRR)</li>
          <li>Carteira agregada por vendedor (health médio, churn risk médio)</li>
          <li>Alertas estratégicos (cliente VIP esfriou, vendedor caiu produção)</li>
        </ul>
      </Card>

      {/* KPIs do próprio Master (também é Closer) */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Meus KPIs (como Closer)</div>
        <KpisToday />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Users className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Vendedores ativos
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Briefcase className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Receita time hoje
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <BarChart3 className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Pipeline total
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
      </div>
    </div>
  );
}
