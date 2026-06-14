// Resumo do universo de alvos do contexto campo + filtro Todos/Clientes/Prospects.
// Avisa quando há alvos demais (o mapa geocodifica no máx ~15 por vez — Nominatim).
import { Users, Target, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TargetFilter } from './types';

const LIMITE_AVISO = 60;

export function FieldTargetsSummary({
  totalClientes,
  totalProspects,
  filtro,
  onFiltroChange,
}: {
  totalClientes: number;
  totalProspects: number;
  filtro: TargetFilter;
  onFiltroChange: (f: TargetFilter) => void;
}) {
  const total = totalClientes + totalProspects;
  const opcoes: { key: TargetFilter; label: string }[] = [
    { key: 'todos', label: 'Todos' },
    { key: 'clientes', label: 'Clientes' },
    { key: 'prospects', label: 'Prospects' },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-semibold text-foreground">{total} alvos</span>
          <span className="flex items-center gap-1 text-orange-600">
            <Users className="w-3.5 h-3.5" /> {totalClientes} clientes
          </span>
          <span className="flex items-center gap-1 text-yellow-600">
            <Target className="w-3.5 h-3.5" /> {totalProspects} prospects
          </span>
        </div>
        <div className="flex gap-1">
          {opcoes.map((o) => (
            <Button
              key={o.key}
              size="sm"
              variant={filtro === o.key ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => onFiltroChange(o.key)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>
      {total > LIMITE_AVISO && (
        <div className="flex items-center gap-2 rounded-md bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Muitos alvos ({total}). O mapa mostra os primeiros geocodificados — refine as cidades ou use o filtro acima.
        </div>
      )}
    </div>
  );
}
