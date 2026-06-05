import { KpisToday } from './KpisToday';
import { TeamKpiTiles } from './TeamKpiTiles';
import { RankingVendedoresCard } from './RankingVendedoresCard';
import { VisitSuggestionsCard } from './VisitSuggestionsCard';
import { ViewAsPicker } from '@/components/impersonation/ViewAsPicker';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { GestorExcecoes } from './GestorExcecoes';

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

      {/* GestorBuddy — console de exceções (Buddy v2) */}
      <GestorExcecoes />

      {/* KPIs do próprio Master (também é Closer) */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Meus KPIs (como Closer)</div>
        <KpisToday />
      </div>

      {/* KPIs de time (read-only, escopo da empresa ativa do CompanySwitcher) */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Time</div>
        <TeamKpiTiles />
        <RankingVendedoresCard />
      </div>
    </div>
  );
}
