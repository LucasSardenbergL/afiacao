import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import { useFarmerPerformance, type PerformanceScore } from '@/hooks/useFarmerPerformance';
import { supabase } from '@/integrations/supabase/client';
import { useUserRole } from '@/hooks/useUserRole';
import {
  Loader2, TrendingUp, DollarSign, BarChart3, Users, ShieldCheck,
  RefreshCw, Layers, Target, Brain, Eye, FileText, Activity
} from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const scoreColor = (v: number) =>
  v >= 75 ? 'text-emerald-600' : v >= 50 ? 'text-amber-600' : 'text-red-600';

const scoreBarColor = (v: number) =>
  v >= 75 ? '[&>div]:bg-emerald-500' : v >= 50 ? '[&>div]:bg-amber-500' : '[&>div]:bg-red-500';

const ExecutiveDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { role, loading: roleLoading } = useUserRole();
  const { scores, loading, calculating, loadScores, calculateScores } = useFarmerPerformance();
  const [farmers, setFarmers] = useState<{ id: string; name: string }[]>([]);
  const [selectedFarmer, setSelectedFarmer] = useState<string>('all');

  useEffect(() => {
    if (role === 'admin') {
      loadScores();
      loadFarmers();
    }
  }, [role]);

  const loadFarmers = async () => {
    // Get all employees/farmers
    const { data: roles } = await supabase
      .from('user_roles')
      .select('user_id')
      .in('role', ['employee', 'admin']) as any;

    if (!roles?.length) return;
    const ids = roles.map((r: any) => r.user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, name')
      .in('user_id', ids) as any;

    if (profiles) {
      setFarmers(profiles.map((p: any) => ({ id: p.user_id, name: p.name })));
    }
  };

  if (roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (role !== 'admin') {
    navigate('/', { replace: true });
    return null;
  }

  // Group scores by farmer, get latest for each
  const farmerScoreMap = new Map<string, PerformanceScore>();
  for (const s of scores) {
    if (!farmerScoreMap.has(s.farmerId)) {
      farmerScoreMap.set(s.farmerId, s);
    }
  }
  const latestScores = Array.from(farmerScoreMap.values());

  const filteredScores = selectedFarmer === 'all'
    ? latestScores
    : latestScores.filter(s => s.farmerId === selectedFarmer);

  const filteredHistory = selectedFarmer === 'all'
    ? scores
    : scores.filter(s => s.farmerId === selectedFarmer);

  // Correlation data
  const avgIEE = filteredScores.length > 0
    ? Math.round(filteredScores.reduce((s, sc) => s + sc.ieeTotal, 0) / filteredScores.length)
    : 0;
  const avgIPF = filteredScores.length > 0
    ? Math.round(filteredScores.reduce((s, sc) => s + sc.ipfTotal, 0) / filteredScores.length)
    : 0;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Painel Executivo" showBack />

      <main className="px-4 py-4 space-y-3 max-w-lg mx-auto">
        {/* Header */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Eye className="w-5 h-5 text-primary" />
              <h2 className="text-sm font-bold">Painel Executivo — IEE + IPF</h2>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Visão completa: execução estratégica (IEE) e performance financeira (IPF) por Farmer.
            </p>
          </CardContent>
        </Card>

        {/* Farmer filter + calculate */}
        <div className="flex gap-2">
          <Select value={selectedFarmer} onValueChange={setSelectedFarmer}>
            <SelectTrigger className="h-8 text-xs flex-1">
              <SelectValue placeholder="Filtrar Farmer" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">Todos os Farmers</SelectItem>
              {farmers.map(f => (
                <SelectItem key={f.id} value={f.id} className="text-xs">{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[10px] shrink-0 gap-1"
            disabled={calculating || selectedFarmer === 'all'}
            onClick={() => selectedFarmer !== 'all' && calculateScores(selectedFarmer)}
          >
            {calculating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Calcular
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : filteredScores.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs text-muted-foreground">
                Nenhum índice calculado. Selecione um Farmer e clique em "Calcular".
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Global Averages */}
            <div className="grid grid-cols-2 gap-2">
              <Card>
                <CardContent className="p-3 text-center">
                  <p className="text-[9px] text-muted-foreground">IEE Médio</p>
                  <p className={`text-2xl font-black ${scoreColor(avgIEE)}`}>{avgIEE}</p>
                  <Progress value={avgIEE} className={`h-1.5 mt-1 ${scoreBarColor(avgIEE)}`} />
                  <p className="text-[8px] text-muted-foreground mt-1">Execução Estratégica</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 text-center">
                  <p className="text-[9px] text-muted-foreground">IPF Médio</p>
                  <p className={`text-2xl font-black ${scoreColor(avgIPF)}`}>{avgIPF}</p>
                  <Progress value={avgIPF} className={`h-1.5 mt-1 ${scoreBarColor(avgIPF)}`} />
                  <p className="text-[8px] text-muted-foreground mt-1">Performance Financeira</p>
                </CardContent>
              </Card>
            </div>

            {/* Correlation Insight */}
            <Card className="border-dashed">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="w-3.5 h-3.5 text-primary" />
                  <span className="text-[10px] font-semibold">Correlação IEE ↔ IPF</span>
                </div>
                <p className="text-[9px] text-muted-foreground">
                  {Math.abs(avgIEE - avgIPF) <= 15
                    ? '✅ Boa correlação: Farmers que seguem o plano tático estão gerando resultado financeiro proporcional.'
                    : avgIEE > avgIPF
                    ? '⚠️ IEE alto, IPF baixo: Farmers seguem os planos, mas os resultados financeiros não acompanham. Revisar qualidade das estratégias.'
                    : '⚠️ IPF alto, IEE baixo: Bons resultados apesar de baixa aderência ao plano. Possível talento individual, mas risco de inconsistência.'}
                </p>
              </CardContent>
            </Card>

            {/* Per-Farmer Scores */}
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-xs flex items-center gap-2">
                  <Users className="w-3 h-3" /> Scores por Farmer
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-3">
                {filteredScores.map(s => (
                  <div key={s.id} className="border rounded-lg p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold">{s.farmerName}</span>
                      <div className="flex gap-1">
                        <Badge variant="outline" className="text-[8px]">{s.totalCalls} lig.</Badge>
                        <Badge variant="outline" className="text-[8px]">{fmt(s.totalMargin)}</Badge>
                      </div>
                    </div>

                    {/* IEE Bar */}
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="flex items-center gap-1">
                          <Brain className="w-3 h-3 text-blue-500" />
                          <span className="text-[9px] font-medium">IEE</span>
                        </div>
                        <span className={`text-xs font-bold ${scoreColor(s.ieeTotal)}`}>{s.ieeTotal}</span>
                      </div>
                      <Progress value={s.ieeTotal} className={`h-1.5 ${scoreBarColor(s.ieeTotal)}`} />
                      <div className="grid grid-cols-5 gap-0.5 mt-1 text-[7px] text-muted-foreground text-center">
                        <div>
                          <p className="font-medium">{s.ieePtplUsage}</p>
                          <p>PTPL</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ieeObjectiveAdherence}</p>
                          <p>Aderên.</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ieeQuestionsUsage}</p>
                          <p>Pergun.</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ieeBundleOffered}</p>
                          <p>Bundle</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ieePostCallRegistration}</p>
                          <p>Registro</p>
                        </div>
                      </div>
                    </div>

                    {/* IPF Bar */}
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="flex items-center gap-1">
                          <DollarSign className="w-3 h-3 text-emerald-500" />
                          <span className="text-[9px] font-medium">IPF</span>
                        </div>
                        <span className={`text-xs font-bold ${scoreColor(s.ipfTotal)}`}>{s.ipfTotal}</span>
                      </div>
                      <Progress value={s.ipfTotal} className={`h-1.5 ${scoreBarColor(s.ipfTotal)}`} />
                      <div className="grid grid-cols-5 gap-0.5 mt-1 text-[7px] text-muted-foreground text-center">
                        <div>
                          <p className="font-medium">{s.ipfIncrementalMargin}</p>
                          <p>Margem</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ipfMarginPerHour}</p>
                          <p>$/Hora</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ipfMixExpansion}</p>
                          <p>Mix</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ipfLtvEvolution}</p>
                          <p>LTV</p>
                        </div>
                        <div>
                          <p className="font-medium">{s.ipfChurnReduction}</p>
                          <p>Churn</p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Temporal Evolution */}
            {filteredHistory.length > 1 && (
              <Card>
                <CardHeader className="p-3 pb-2">
                  <CardTitle className="text-xs flex items-center gap-2">
                    <TrendingUp className="w-3 h-3" /> Evolução Temporal
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0 space-y-1.5">
                  {filteredHistory.slice(0, 8).map(s => (
                    <div key={s.id} className="flex items-center gap-2 text-[9px]">
                      <span className="text-muted-foreground w-16 shrink-0">
                        {new Date(s.periodEnd).toLocaleDateString('pt-BR')}
                      </span>
                      <span className="text-muted-foreground w-14 shrink-0">{s.farmerName.split(' ')[0]}</span>
                      <div className="flex items-center gap-1 flex-1">
                        <span className="text-[8px] text-blue-600 w-6">IEE</span>
                        <Progress value={s.ieeTotal} className={`h-1 flex-1 ${scoreBarColor(s.ieeTotal)}`} />
                        <span className="font-medium w-5 text-right">{s.ieeTotal}</span>
                      </div>
                      <div className="flex items-center gap-1 flex-1">
                        <span className="text-[8px] text-emerald-600 w-6">IPF</span>
                        <Progress value={s.ipfTotal} className={`h-1 flex-1 ${scoreBarColor(s.ipfTotal)}`} />
                        <span className="font-medium w-5 text-right">{s.ipfTotal}</span>
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

export default ExecutiveDashboard;
