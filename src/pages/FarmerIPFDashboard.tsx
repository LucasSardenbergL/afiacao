import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/contexts/AuthContext';
import { useFarmerPerformance } from '@/hooks/useFarmerPerformance';
import {
  Loader2, TrendingUp, DollarSign, BarChart3, Users, ShieldCheck,
  RefreshCw, Layers, Target
} from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const scoreColor = (v: number) =>
  v >= 75 ? 'text-emerald-600' : v >= 50 ? 'text-amber-600' : 'text-red-600';

const scoreBarColor = (v: number) =>
  v >= 75 ? '[&>div]:bg-emerald-500' : v >= 50 ? '[&>div]:bg-amber-500' : '[&>div]:bg-red-500';

const FarmerIPFDashboard = () => {
  const navigate = useNavigate();
  const { user, isStaff } = useAuth();
  const { scores, loading, calculating, loadScores, calculateScores } = useFarmerPerformance();

  useEffect(() => {
    if (user?.id && isStaff) {
      loadScores(user.id);
    }
  }, [user, isStaff]);

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  const latestScore = scores[0] || null;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Performance Financeira" showBack />

      <main className="px-4 py-4 space-y-3 max-w-lg mx-auto">
        {/* Header */}
        <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-emerald-500/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-5 h-5 text-emerald-600" />
              <h2 className="text-sm font-bold">IPF — Índice de Performance Financeira</h2>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Mede o resultado econômico real: margem, mix, LTV e redução de churn.
            </p>
          </CardContent>
        </Card>

        {/* Calculate / Refresh */}
        <Button
          variant="outline"
          className="w-full text-xs gap-2"
          onClick={() => user?.id && calculateScores(user.id)}
          disabled={calculating}
        >
          {calculating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {calculating ? 'Calculando...' : 'Recalcular IPF (últimos 30 dias)'}
        </Button>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : !latestScore ? (
          <Card>
            <CardContent className="p-6 text-center">
              <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs text-muted-foreground">
                Nenhum índice calculado ainda. Clique em "Recalcular IPF" para gerar.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* IPF Total Score */}
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-[10px] text-muted-foreground mb-1">Pontuação IPF</p>
                <p className={`text-4xl font-black ${scoreColor(latestScore.ipfTotal)}`}>
                  {latestScore.ipfTotal}
                </p>
                <p className="text-[9px] text-muted-foreground mt-1">de 100 pontos</p>
                <Progress value={latestScore.ipfTotal} className={`h-2 mt-2 ${scoreBarColor(latestScore.ipfTotal)}`} />
              </CardContent>
            </Card>

            {/* IPF Components */}
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-xs flex items-center gap-2">
                  <Layers className="w-3 h-3" /> Componentes do IPF
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-3">
                <IPFMetric label="Margem Incremental" value={latestScore.ipfIncrementalMargin} weight={25} icon={DollarSign} />
                <IPFMetric label="Margem por Hora" value={latestScore.ipfMarginPerHour} weight={25} icon={TrendingUp} />
                <IPFMetric label="Expansão de Mix" value={latestScore.ipfMixExpansion} weight={20} icon={Target} />
                <IPFMetric label="Evolução de LTV" value={latestScore.ipfLtvEvolution} weight={15} icon={BarChart3} />
                <IPFMetric label="Redução de Churn" value={latestScore.ipfChurnReduction} weight={15} icon={ShieldCheck} />
              </CardContent>
            </Card>

            {/* Summary Stats */}
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-xs">Resumo do Período</CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0">
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div className="bg-muted/50 rounded p-2 text-center">
                    <p className="font-bold text-sm">{latestScore.totalCalls}</p>
                    <p className="text-muted-foreground">Ligações</p>
                  </div>
                  <div className="bg-muted/50 rounded p-2 text-center">
                    <p className="font-bold text-sm">{fmt(latestScore.totalMargin)}</p>
                    <p className="text-muted-foreground">Margem Total</p>
                  </div>
                  <div className="bg-muted/50 rounded p-2 text-center">
                    <p className="font-bold text-sm">{latestScore.totalPlans}</p>
                    <p className="text-muted-foreground">Planos Gerados</p>
                  </div>
                  <div className="bg-muted/50 rounded p-2 text-center">
                    <p className="font-bold text-sm">
                      {latestScore.totalTimeSeconds > 0 ? `${Math.round(latestScore.totalTimeSeconds / 3600)}h` : '-'}
                    </p>
                    <p className="text-muted-foreground">Tempo Total</p>
                  </div>
                </div>
                <p className="text-[9px] text-muted-foreground mt-2 text-center">
                  Período: {new Date(latestScore.periodStart).toLocaleDateString('pt-BR')} — {new Date(latestScore.periodEnd).toLocaleDateString('pt-BR')}
                </p>
              </CardContent>
            </Card>

            {/* Historical scores */}
            {scores.length > 1 && (
              <Card>
                <CardHeader className="p-3 pb-2">
                  <CardTitle className="text-xs">Evolução IPF</CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0 space-y-1.5">
                  {scores.slice(0, 5).map(s => (
                    <div key={s.id} className="flex items-center justify-between text-[10px]">
                      <span className="text-muted-foreground">
                        {new Date(s.periodEnd).toLocaleDateString('pt-BR')}
                      </span>
                      <div className="flex items-center gap-2">
                        <Progress value={s.ipfTotal} className={`h-1.5 w-20 ${scoreBarColor(s.ipfTotal)}`} />
                        <span className={`font-bold ${scoreColor(s.ipfTotal)}`}>{s.ipfTotal}</span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

const IPFMetric = ({ label, value, weight, icon: Icon }: { label: string; value: number; weight: number; icon: any }) => (
  <div>
    <div className="flex items-center justify-between mb-1">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3 h-3 text-muted-foreground" />
        <span className="text-[10px]">{label}</span>
        <Badge variant="outline" className="text-[7px] h-3 px-1">{weight}%</Badge>
      </div>
      <span className={`text-xs font-bold ${scoreColor(value)}`}>{value}</span>
    </div>
    <Progress value={value} className={`h-1.5 ${scoreBarColor(value)}`} />
  </div>
);

export default FarmerIPFDashboard;
