import { Card } from '@/components/ui/card';
import { Construction } from 'lucide-react';
import { KpisToday } from './KpisToday';
import { TeamKpiTiles } from './TeamKpiTiles';
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

      {/* KPIs de time (read-only, escopo da empresa ativa do CompanySwitcher) */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Time</div>
        <TeamKpiTiles />
      </div>
    </div>
  );
}
