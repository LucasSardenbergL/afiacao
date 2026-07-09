// Abas de contexto do Roteirizador: "Visitas em campo" (hunter) × "Planejamento
// da equipe" (operacional). Só renderiza quando o usuário tem acesso ao campo
// (gestor/master); para o resto da equipe a tela não muda (o pai nem monta isto).
import { MapPin, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlanningContext } from './types';

const TABS: { key: PlanningContext; label: string; icon: typeof MapPin; hint: string }[] = [
  { key: 'campo', label: 'Visitas em campo', icon: MapPin, hint: 'Caçar clientes e prospects por cidade' },
  { key: 'equipe', label: 'Planejamento da equipe', icon: Users, hint: 'Logística, comercial, híbrido, manual' },
];

export function RoutePlannerContextTabs({
  value,
  onChange,
}: {
  value: PlanningContext;
  onChange: (ctx: PlanningContext) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-1">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = value === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            title={tab.hint}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="w-4 h-4" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
