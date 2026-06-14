// Seletor de modo do contexto "Planejamento da equipe" (logística/comercial/
// híbrido/manual). O modo "prospecção" saiu daqui — virou o contexto "Visitas em
// campo" (RoutePlannerContextTabs). Renderizado só no contexto equipe.
import type { ReactNode } from 'react';
import { Route, Truck, ShoppingBag, Layers, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PlanningMode } from './types';

export function PlanningModeSelector({
  value,
  onChange,
}: {
  value: PlanningMode;
  onChange: (mode: PlanningMode) => void;
}) {
  const baseModes: { key: PlanningMode; label: string; icon: ReactNode }[] = [
    { key: 'logistica', label: 'Logística', icon: <Truck className="w-3.5 h-3.5" /> },
    { key: 'comercial', label: 'Comercial', icon: <ShoppingBag className="w-3.5 h-3.5" /> },
    { key: 'hibrido', label: 'Híbrido', icon: <Layers className="w-3.5 h-3.5" /> },
    { key: 'manual', label: 'Manual', icon: <Users className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Route className="w-4 h-4 text-muted-foreground" />
      <span className="text-sm font-medium text-muted-foreground">Modo:</span>
      {baseModes.map((mode) => (
        <Button
          key={mode.key}
          variant={value === mode.key ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(mode.key)}
          className="gap-1.5"
        >
          {mode.icon}
          {mode.label}
        </Button>
      ))}
    </div>
  );
}
