// Aba "Visão Geral" da tela FarmerLOCC (usa dados do pai + cross-sell engine).
// Extraída verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { memo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Loader2, Heart, RefreshCw, Zap, ChevronRight } from 'lucide-react';
import { useCrossSellEngine } from '@/hooks/useCrossSellEngine';
import { type FarmerMetrics } from '@/hooks/useFarmerMetrics';
import { type ScoringSummary } from './types';
import { fmt, healthColors } from './helpers';

export const OverviewTab = memo(({ summary, metrics, scoringCalc, recalculate, navigate }: {
  summary: ScoringSummary;
  metrics: FarmerMetrics;
  scoringCalc: boolean;
  recalculate: () => void;
  navigate: (path: string) => void;
}) => {
  // Cross-sell engine only loaded when overview renders (always on mount)
  const { recommendations } = useCrossSellEngine();

  return (
    <>
      {/* Health Summary */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Heart className="w-4 h-4 text-primary" />
              <span className="text-xs font-semibold">Motor de Diagnóstico</span>
            </div>
            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={recalculate} disabled={scoringCalc}>
              {scoringCalc ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-1 text-center">
            {(['saudavel', 'estavel', 'atencao', 'critico'] as const).map(cls => {
              const count = summary[cls];
              const hc = healthColors[cls];
              return (
                <div key={cls} className={`rounded-lg p-1.5 ${hc.bg}`}>
                  <p className={`text-lg font-bold ${hc.text}`}>{count}</p>
                  <p className="text-[9px] text-muted-foreground capitalize">{cls === 'saudavel' ? 'Saudável' : cls === 'estavel' ? 'Estável' : cls === 'atencao' ? 'Atenção' : 'Crítico'}</p>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between text-xs mt-2">
            <span className="text-muted-foreground">Health Score Médio</span>
            <span className="font-bold">{summary.avgHealth}</span>
          </div>
          <Progress value={summary.avgHealth} className="h-1.5 mt-1" />
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-2.5 text-center">
            <p className="text-lg font-bold">{fmt(metrics.marginPerHour)}</p>
            <p className="text-[9px] text-muted-foreground">Margem/Hora</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 text-center">
            <p className="text-lg font-bold">{Math.round(metrics.capacityPerDay)}</p>
            <p className="text-[9px] text-muted-foreground">Cap./Dia</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 text-center">
            <p className="text-lg font-bold">{summary.totalClients}</p>
            <p className="text-[9px] text-muted-foreground">Clientes</p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Cross-sell summary */}
      <Card className="cursor-pointer" onClick={() => navigate('/farmer/recommendations')}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-status-warning" />
              <span className="text-xs font-semibold">Recomendações</span>
            </div>
            <div className="flex items-center gap-1">
              {/* Contagem, não moeda: o total antigo somava os LIE em R$, e sem custo no browser
                  não existe lucro esperado. Formatar o score de afinidade como BRL seria fabricar
                  número — e a soma nem é comensurável entre cross-sell e up-sell. */}
              <span className="text-xs font-bold text-status-success">
                {recommendations.reduce((s, r) => s + r.crossSell.length + r.upSell.length, 0)}
              </span>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
});
OverviewTab.displayName = 'OverviewTab';
