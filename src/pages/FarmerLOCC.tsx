import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { useFarmerMetrics } from '@/hooks/useFarmerMetrics';
import { useAuth } from '@/contexts/AuthContext';
import {
  Heart, Target, Shield, FlaskConical,
  Phone, Package, Radio, Zap, DollarSign,
  RefreshCw, Loader2,
} from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { type TabKey } from '@/components/farmer/locc/types';
import { TabSkeleton } from '@/components/farmer/locc/primitives';
import { OverviewTab } from '@/components/farmer/locc/OverviewTab';
import { ExperimentsTab } from '@/components/farmer/locc/ExperimentsTab';
import { CapacityTab } from '@/components/farmer/locc/CapacityTab';
import { AdaptiveTab } from '@/components/farmer/locc/AdaptiveTab';

// ─── Main Component ──────────────────────────────────────────────────
const FarmerLOCC = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();

  // Only overview-critical hooks at page level
  const { summary, clientScores, loading: scoringLoading, calculating: scoringCalc, recalculate, config, erro } = useFarmerScoring();
  const { metrics, loading: metricsLoading } = useFarmerMetrics();

  // Track which tabs have been visited (overview is always visited)
  const [visitedTabs, setVisitedTabs] = useState<Set<TabKey>>(new Set(['overview']));

  const handleTabChange = useCallback((value: string) => {
    setVisitedTabs(prev => {
      if (prev.has(value as TabKey)) return prev;
      const next = new Set(prev);
      next.add(value as TabKey);
      return next;
    });
  }, []);

  const loading = authLoading || scoringLoading || metricsLoading;

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <main className="px-4 py-4 max-w-lg mx-auto">
          <PageSkeleton variant="cockpit" />
        </main>
      </div>
    );
  }

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  // §7 do money-path: o `summary` é o pior caso da classe porque FABRICA o número explícito —
  // `useFarmerScoring` tem, literal, `if (clientScores.length === 0) return { avgHealth: 0,
  // saudavel: 0, … }`. Sob falha de leitura `clientScores === []`, então o Motor de Diagnóstico
  // exibiria quatro zeros e "Health Score Médio 0" com a barra em 0: números de decisão
  // inventados por uma falha de transporte (`Number(null) === 0` do CLAUDE.md — ausente ≠ zero).
  const diagnosticoIndisponivel = !!erro && clientScores.length === 0;
  const diagnosticoDesatualizado = !!erro && clientScores.length > 0;

  return (
    <div className="min-h-screen bg-background pb-24">

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {/* Header Card */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <FlaskConical className="w-5 h-5 text-primary" />
              <h2 className="text-sm font-bold">Laboratório de Otimização Comercial Contínuo</h2>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Sistema adaptativo: testa, mede e otimiza margem incremental por hora, LTV e churn.
            </p>
          </CardContent>
        </Card>

        {/* Quick Navigation */}
        <div className="grid grid-cols-4 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Heart className="w-4 h-4" />
            <span className="text-[9px]">Diagnóstico</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/calls')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Phone className="w-4 h-4" />
            <span className="text-[9px]">Ligações</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/recommendations')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Zap className="w-4 h-4" />
            <span className="text-[9px]">Cross/Up</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/bundles')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Package className="w-4 h-4" />
            <span className="text-[9px]">Bundles</span>
          </Button>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/tactical-plan')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Target className="w-4 h-4" />
            <span className="text-[9px]">PTPL</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/copilot')} className="h-auto py-2 flex flex-col items-center gap-1">
            <Radio className="w-4 h-4" />
            <span className="text-[9px]">Copiloto</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/ipf')} className="h-auto py-2 flex flex-col items-center gap-1">
            <DollarSign className="w-4 h-4" />
            <span className="text-[9px]">IPF</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/governance')} className="h-auto py-2 flex flex-col items-center gap-1 relative">
            <Shield className="w-4 h-4" />
            <span className="text-[9px]">Governança</span>
          </Button>
        </div>

        <Tabs defaultValue="overview" className="w-full" onValueChange={handleTabChange}>
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="overview" className="text-[10px] px-1">Visão Geral</TabsTrigger>
            <TabsTrigger value="experiments" className="text-[10px] px-1">Experimentos</TabsTrigger>
            <TabsTrigger value="capacity" className="text-[10px] px-1">Capacidade</TabsTrigger>
            <TabsTrigger value="adaptive" className="text-[10px] px-1">Otimização</TabsTrigger>
          </TabsList>

          {/* ─── OVERVIEW TAB ──────────────────────────────────────── */}
          <TabsContent value="overview" className="space-y-3 mt-3">
            {diagnosticoIndisponivel ? (
              <Card role="alert" className="border-status-error/30 bg-status-error/5">
                <CardContent className="p-4 space-y-3">
                  <p className="text-sm text-status-error">
                    Diagnóstico indisponível — a leitura da carteira falhou ({erro}). Nenhum
                    health score foi estimado; isto não significa carteira sem clientes.
                  </p>
                  <Button
                    variant="outline" size="sm" onClick={recalculate}
                    disabled={scoringCalc} className="gap-1.5"
                  >
                    {scoringCalc ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Tentar novamente
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <>
                {diagnosticoDesatualizado && (
                  <div
                    role="alert"
                    className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning"
                  >
                    Exibindo a última leitura bem-sucedida — a atualização mais recente falhou
                    ({erro}). Os números podem estar desatualizados.
                  </div>
                )}
                <OverviewTab
                  summary={summary}
                  metrics={metrics}
                  scoringCalc={scoringCalc}
                  recalculate={recalculate}
                  navigate={navigate}
                />
              </>
            )}
          </TabsContent>

          {/* ─── EXPERIMENTS TAB ─────────────────────────────────── */}
          <TabsContent value="experiments" className="space-y-3 mt-3">
            {visitedTabs.has('experiments') ? <ExperimentsTab /> : <TabSkeleton />}
          </TabsContent>

          {/* ─── CAPACITY TAB ────────────────────────────────────── */}
          <TabsContent value="capacity" className="space-y-3 mt-3">
            {visitedTabs.has('capacity') ? <CapacityTab metrics={metrics} /> : <TabSkeleton />}
          </TabsContent>

          {/* ─── ADAPTIVE TAB ────────────────────────────────────── */}
          <TabsContent value="adaptive" className="space-y-3 mt-3">
            {visitedTabs.has('adaptive') ? <AdaptiveTab config={config} metrics={metrics} navigate={navigate} /> : <TabSkeleton />}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default FarmerLOCC;
