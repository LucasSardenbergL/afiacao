// Cards de estatísticas do AI Ops (Prioridades / Oportunidades / Riscos).
// Extraído verbatim de src/pages/AIops.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Target, Zap, Shield } from 'lucide-react';

interface StatsCardsProps {
  prioridadesCount: number;
  oportunidadesCount: number;
  riscosCount: number;
}

export function StatsCards({ prioridadesCount, oportunidadesCount, riscosCount }: StatsCardsProps) {
  const statsCards = [
    {
      icon: Target,
      label: 'Prioridades',
      value: prioridadesCount,
      color: 'text-primary',
    },
    {
      icon: Zap,
      label: 'Oportunidades',
      value: oportunidadesCount,
      color: 'text-emerald-600 dark:text-emerald-400',
    },
    {
      icon: Shield,
      label: 'Riscos',
      value: riscosCount,
      color: 'text-destructive',
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-4">
      {statsCards.map((s) => (
        <Card key={s.label}>
          <CardContent className="p-4 flex items-center gap-3">
            <s.icon className={`w-8 h-8 ${s.color}`} />
            <div>
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-sm text-muted-foreground">{s.label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
