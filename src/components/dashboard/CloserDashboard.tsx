import { Card } from '@/components/ui/card';
import { Construction, MapPin, Target, TrendingUp } from 'lucide-react';
import { VisitSuggestionsCard } from './VisitSuggestionsCard';
import { VisitasHojeCard } from './VisitasHojeCard';
import { MinhasVisitasResultadoCard } from './MinhasVisitasResultadoCard';
import { FollowupsSugeridosCard } from './FollowupsSugeridosCard';
import { MinhasTarefasCard } from '@/components/tarefas/MinhasTarefasCard';

/**
 * Dashboard Closer — placeholder rico até PR-VISIT-INTELLIGENCE implementar
 * algoritmo de sugestão de visita + rota geo + 4 tipos de missão.
 */
export function CloserDashboard() {
  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Dashboard Closer (outbound presencial)</h1>
        <p className="text-xs text-muted-foreground">
          Foco em visitas de alto valor — fechar deals complexos pro Hunter, expansão pra Farmer, recovery de churn, relationship pra clientes VIP.
        </p>
      </div>

      <MinhasTarefasCard />

      <VisitasHojeCard />

      {/* Sugestões de visita — PR-VISIT-INTELLIGENCE Sub-PR A */}
      <VisitSuggestionsCard />

      {/* Follow-ups pós-visita: visitas mornas que pedem retorno (read-only, deep-link) */}
      <FollowupsSugeridosCard />

      <MinhasVisitasResultadoCard />

      <Card className="p-4 border-dashed border-2 border-status-warning/30 bg-status-warning-bg/20">
        <div className="flex items-center gap-2 mb-2">
          <Construction className="w-4 h-4 text-status-warning" />
          <span className="text-sm font-medium">Em construção — PR-VISIT-INTELLIGENCE</span>
        </div>
        <p className="text-2xs text-muted-foreground">Próximas features:</p>
        <ul className="text-2xs text-muted-foreground space-y-1 mt-2 ml-4 list-disc">
          <li>4 tipos de missão: 🎯 Closing / 🌟 Expansion / 🚨 Recovery / 🤝 Relationship</li>
          <li>Algoritmo de visit_score (potencial × probabilidade × urgência × proximidade)</li>
          <li>Rota geográfica eficiente (visitas agrupadas por região)</li>
          <li>Pre-call brief incrível antes de cada visita (consome PR-P3 + PR-CAPTURE + KB)</li>
          <li>Registro de resultado da visita + métricas (Visit Conversion, ROI por visita)</li>
          <li>Fila de pedidos vindos de Farmer/Hunter (&quot;solicitar visita&quot;)</li>
        </ul>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <Target className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Visitas pendentes
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <MapPin className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Próxima visita
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          <TrendingUp className="w-5 h-5 mx-auto mb-1 opacity-40" />
          Win rate
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
        <Card className="p-3 text-center text-xs text-muted-foreground">
          Avg deal size
          <div className="text-base font-medium text-foreground mt-1">—</div>
        </Card>
      </div>
    </div>
  );
}
