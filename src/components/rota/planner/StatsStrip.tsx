// Faixa de estatísticas (contagem de paradas por tipo) do planejador de rotas.
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
import { Truck, ShoppingBag, Layers } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { STOP_CONFIG } from './constants';
import type { PlanningMode, StopType } from './types';

type StatStopType = 'pickup_tools' | 'deliver_tools' | 'sales_visit' | 'hybrid_visit';

export function StatsStrip({
  planningMode,
  stopCounts,
}: {
  planningMode: PlanningMode;
  stopCounts: Record<StatStopType, number>;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {([
        { type: 'pickup_tools' as StopType, icon: Truck },
        { type: 'deliver_tools' as StopType, icon: Truck },
        { type: 'sales_visit' as StopType, icon: ShoppingBag },
        { type: 'hybrid_visit' as StopType, icon: Layers },
      ]).filter(s => {
        if (planningMode === 'logistica') return s.type === 'pickup_tools' || s.type === 'deliver_tools';
        if (planningMode === 'comercial') return s.type === 'sales_visit' || s.type === 'hybrid_visit';
        return true;
      }).map(s => {
        const cfg = STOP_CONFIG[s.type];
        return (
          <Card key={s.type}>
            <CardContent className="pt-3 pb-2 px-3 flex items-center gap-2">
              <div className={`p-1.5 rounded-md ${cfg.bgClass}`}>
                <s.icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-lg font-bold text-foreground">{stopCounts[s.type as StatStopType]}</p>
                <p className="text-[10px] text-muted-foreground leading-tight">{cfg.label}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
