// Filtro de período (todos/manhã/tarde) do planejador de rotas.
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FilterPeriod } from './types';

export function PeriodFilter({
  value,
  onChange,
}: {
  value: FilterPeriod;
  onChange: (period: FilterPeriod) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Filter className="w-4 h-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Período:</span>
      {(['all', 'manha', 'tarde'] as FilterPeriod[]).map(period => (
        <Button
          key={period}
          variant={value === period ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onChange(period)}
        >
          {period === 'all' ? 'Todos' : period === 'manha' ? 'Manhã' : 'Tarde'}
        </Button>
      ))}
    </div>
  );
}
