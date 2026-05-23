// Seletor de modo de planejamento (logística/comercial/híbrido/manual).
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
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
  return (
    <div className="flex items-center gap-2">
      <Route className="w-4 h-4 text-muted-foreground" />
      <span className="text-sm font-medium text-muted-foreground">Modo:</span>
      {([
        { key: 'logistica' as PlanningMode, label: 'Logística', icon: <Truck className="w-3.5 h-3.5" /> },
        { key: 'comercial' as PlanningMode, label: 'Comercial', icon: <ShoppingBag className="w-3.5 h-3.5" /> },
        { key: 'hibrido' as PlanningMode, label: 'Híbrido', icon: <Layers className="w-3.5 h-3.5" /> },
        { key: 'manual' as PlanningMode, label: 'Manual', icon: <Users className="w-3.5 h-3.5" /> },
      ]).map(mode => (
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
