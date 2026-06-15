import { ClosersMtdHero } from './ClosersMtdHero';
import { VisitasKpiTiles } from './VisitasKpiTiles';
import { VisitasHojeCard } from './VisitasHojeCard';
import { VisitSuggestionsCard } from './VisitSuggestionsCard';
import { FollowupsSugeridosCard } from './FollowupsSugeridosCard';
import { MinhasVisitasResultadoCard } from './MinhasVisitasResultadoCard';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';
import { ChamadasPendentesNudge } from '@/components/farmer/ChamadasPendentesNudge';

/**
 * Dashboard Closer (visitas / outbound presencial) — lidera com o PLACAR DO MÊS
 * (output, MTD), depois eficiência recente (30d), depois ação (visitas de hoje,
 * sugestões, follow-ups) e histórico. Tarefas (trabalho dirigido) e o nudge de
 * chamadas (higiene) ficam abaixo, fora do placar.
 *
 * Ordem e definições validadas com Codex
 * (docs/superpowers/specs/2026-06-13-kpis-closer-meu-dia-design.md). O antigo card
 * "Em construção — PR-VISIT-INTELLIGENCE" foi removido: o placar real já está aqui.
 */
export function CloserDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Meu dia (visitas)</h1>
        <p className="text-xs text-muted-foreground">
          Seu placar de visitas do mês e a eficiência recente. Visitas de alto valor: fechar, expandir, recuperar.
        </p>
      </div>

      {/* Placar do mês (output, MTD) — o norte do closer */}
      <ClosersMtdHero />

      {/* Atividade + eficiência recente (30d): pendentes · próxima · conversão · ticket */}
      <VisitasKpiTiles />

      {/* Visitas firmes de hoje */}
      <VisitasHojeCard />

      {/* Sugestões de visita — ação (PR-VISIT-INTELLIGENCE Sub-PR A) */}
      <VisitSuggestionsCard />

      {/* Follow-ups pós-visita: visitas mornas que pedem retorno (read-only, deep-link) */}
      <FollowupsSugeridosCard />

      {/* Breakdown histórico por resultado (90d) */}
      <MinhasVisitasResultadoCard />

      {/* Trabalho dirigido + higiene — abaixo do placar */}
      <MinhasTarefasCard />
      <ChamadasPendentesNudge />
    </div>
  );
}
