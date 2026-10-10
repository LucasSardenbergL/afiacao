// Aba "Visão Geral" da tela FarmerLOCC (usa dados do pai + cross-sell engine).
// Extraída verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { memo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Loader2, Heart, RefreshCw, Zap, ChevronRight } from 'lucide-react';
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
  // Aqui NÃO há motor de cross-sell, e isso é a correção, não uma omissão.
  //
  // Esta aba tinha a sua PRÓPRIA instância de `useCrossSellEngine` e nunca chamava
  // `calculateRecommendations` — o hook é `useState([])` puro, sem efeito de montagem, e só
  // `/farmer/recommendations` dispara o cálculo (na instância DELA). Então o total exibido aqui
  // nunca foi "zero por falha de leitura": era **zero constante desde a origem** (conferido no
  // pré-split #249, onde o mesmo `useCrossSellEngine()` já era chamado sem disparo e o número
  // saía formatado em R$). Ler o `erro` do motor não consertaria nada — não há execução para
  // falhar; o que mentia era a CONTAGEM. Ausente ≠ zero (CLAUDE.md), então ela sai: o card
  // segue levando para a tela que calcula de verdade e já declara `erro`/`desatualizado`.
  //
  // Disparar o motor aqui seria o conserto ERRADO: ele pagina pedidos, scores, catálogo e
  // perfis, PERSISTE o resultado e move o head da geração vigente — carga e escrita que a aba
  // de visão geral não pode decidir por conta própria.
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
            {/* Botão icônico PRECISA de nome acessível: sem ele nem leitor de tela nem teste
                alcançam o recálculo — `getByRole('button', { name: /Recalcular/i })` era a
                única porta para provar o caminho de stale (último dado bom + aviso). */}
            <Button size="sm" variant="ghost" aria-label="Recalcular" className="h-6 text-[10px]" onClick={recalculate} disabled={scoringCalc}>
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
      <Card data-testid="card-recomendacoes" className="cursor-pointer" onClick={() => navigate('/farmer/recommendations')}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-status-warning" />
              <span className="text-xs font-semibold">Recomendações</span>
            </div>
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    </>
  );
});
OverviewTab.displayName = 'OverviewTab';
