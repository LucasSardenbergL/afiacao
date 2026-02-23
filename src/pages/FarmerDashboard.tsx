import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFarmerScoring, type ClientScore, type AgendaItem } from '@/hooks/useFarmerScoring';
import { useFarmerMetrics } from '@/hooks/useFarmerMetrics';
import { useAuth } from '@/contexts/AuthContext';
import {
  Phone, TrendingUp, Users, Target, BarChart3, Brain,
  RefreshCw, Zap, Activity, AlertTriangle, CheckCircle,
  ChevronRight, Shield, Clock, Heart, Loader2
} from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────────────
const healthColors: Record<string, { bg: string; text: string; border: string }> = {
  saudavel: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  estavel: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  atencao: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  critico: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
};
const healthLabels: Record<string, string> = {
  saudavel: '💚 Saudável', estavel: '💙 Estável', atencao: '⚠️ Atenção', critico: '🔴 Crítico',
};
const agendaTypeConfig: Record<string, { label: string; color: string }> = {
  risco: { label: '🔴 Risco', color: 'bg-red-100 text-red-800' },
  expansao: { label: '🟢 Expansão', color: 'bg-emerald-100 text-emerald-800' },
  follow_up: { label: '🔵 Follow-up', color: 'bg-blue-100 text-blue-800' },
};

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDur = (s: number) => {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60) > 0 ? ` ${Math.round(s % 60)}s` : ''}`;
};

const FarmerDashboard = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const { clientScores, agenda, summary, loading, calculating, recalculate, config } = useFarmerScoring();
  const { metrics, loading: metricsLoading } = useFarmerMetrics();
  const [selectedClient, setSelectedClient] = useState<ClientScore | null>(null);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Farmer – Gestão Inteligente" />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {/* Quick Actions */}
        <div className="grid grid-cols-4 gap-2">
          <Button size="sm" onClick={() => navigate('/farmer/calls')} className="h-auto py-3 flex flex-col items-center gap-1">
            <Phone className="w-4 h-4" />
            <span className="text-[10px]">Ligações</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/governance')} className="h-auto py-3 flex flex-col items-center gap-1">
            <Shield className="w-4 h-4" />
            <span className="text-[10px]">Governança</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/recommendations')} className="h-auto py-3 flex flex-col items-center gap-1">
            <Zap className="w-4 h-4" />
            <span className="text-[10px]">Cross/Up</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/farmer/locc')} className="h-auto py-3 flex flex-col items-center gap-1">
            <Activity className="w-4 h-4" />
            <span className="text-[10px]">LOCC</span>
          </Button>
        </div>

        {/* Health Summary */}
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Heart className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold">Saúde da Carteira</span>
              </div>
              <Badge variant="outline" className="text-xs">{summary.totalClients} clientes</Badge>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              {(['saudavel', 'estavel', 'atencao', 'critico'] as const).map(cls => {
                const count = summary[cls];
                const hc = healthColors[cls];
                return (
                  <div key={cls} className={`rounded-lg p-2 ${hc.bg}`}>
                    <p className={`text-lg font-bold ${hc.text}`}>{count}</p>
                    <p className="text-[10px] text-muted-foreground">{cls === 'saudavel' ? 'Saudável' : cls === 'estavel' ? 'Estável' : cls === 'atencao' ? 'Atenção' : 'Crítico'}</p>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Health Score Médio</span>
              <span className="font-bold">{summary.avgHealth}</span>
            </div>
            <Progress value={summary.avgHealth} className="h-2 mt-1" />
          </CardContent>
        </Card>

        <Tabs defaultValue="agenda" className="w-full">
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="agenda" className="text-[10px] px-1">Agenda</TabsTrigger>
            <TabsTrigger value="clients" className="text-[10px] px-1">Clientes</TabsTrigger>
            <TabsTrigger value="capacity" className="text-[10px] px-1">Capacidade</TabsTrigger>
            <TabsTrigger value="learning" className="text-[10px] px-1">IA</TabsTrigger>
          </TabsList>

          {/* AGENDA TAB */}
          <TabsContent value="agenda" className="space-y-2 mt-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-semibold">Agenda do Dia</span>
              <div className="flex gap-1">
                {Object.entries(agendaTypeConfig).map(([k, v]) => (
                  <span key={k} className={`text-[9px] px-1.5 py-0.5 rounded-full ${v.color}`}>
                    {agenda.filter(a => a.agendaType === k).length} {v.label.split(' ')[1]}
                  </span>
                ))}
              </div>
            </div>
            {agenda.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <Target className="w-10 h-10 mx-auto mb-2 opacity-50" />
                Nenhum cliente na agenda. Clique em "Recalcular" para gerar.
              </div>
            ) : (
              agenda.map((item, i) => {
                const atc = agendaTypeConfig[item.agendaType];
                const hc = healthColors[item.healthClass] || healthColors.critico;
                return (
                  <Card key={`${item.customer_user_id}-${i}`} className={`border ${hc.border}`}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{item.customer_name}</p>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${atc.color}`}>
                              {atc.label}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Priority: {item.priorityScore.toFixed(1)} · {healthLabels[item.healthClass]}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => {
                            navigate('/farmer/calls');
                          }}
                        >
                          <Phone className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </TabsContent>

          {/* CLIENTS TAB */}
          <TabsContent value="clients" className="space-y-2 mt-3">
            {selectedClient ? (
              <ClientDetail client={selectedClient} onBack={() => setSelectedClient(null)} config={config} />
            ) : (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold">Ranking por Priority Score</span>
                </div>
                {clientScores.map((client, i) => {
                  const hc = healthColors[client.healthClass] || healthColors.critico;
                  return (
                    <Card
                      key={client.customer_user_id}
                      className={`border ${hc.border} cursor-pointer hover:shadow-sm transition-shadow`}
                      onClick={() => setSelectedClient(client)}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${hc.bg} ${hc.text}`}>
                              {i + 1}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{client.customer_name}</p>
                              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                <span>Health: {client.healthScore.toFixed(0)}</span>
                                <span>·</span>
                                <span>Churn: {client.churnRisk.toFixed(0)}%</span>
                                <span>·</span>
                                <span>{client.daysSinceLastPurchase}d sem compra</span>
                              </div>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-bold">{client.priorityScore.toFixed(1)}</p>
                            <p className="text-[10px] text-muted-foreground">Priority</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </>
            )}
          </TabsContent>

          {/* CAPACITY TAB */}
          <TabsContent value="capacity" className="space-y-3 mt-3">
            <div className="grid grid-cols-2 gap-3">
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Target className="w-4 h-4 text-primary" />
                    <span className="text-[10px] text-muted-foreground">Capacidade/Dia</span>
                  </div>
                  <p className="text-2xl font-bold">{Math.round(metrics.capacityPerDay)}</p>
                  <p className="text-[10px] text-muted-foreground">ligações</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="w-4 h-4 text-primary" />
                    <span className="text-[10px] text-muted-foreground">Carteira Ideal</span>
                  </div>
                  <p className="text-2xl font-bold">{metrics.optimalClientsCount}</p>
                  <p className="text-[10px] text-muted-foreground">clientes</p>
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardContent className="p-3 space-y-2">
                <MetricRow label="T_call médio" value={fmtDur(metrics.avgCallDuration)} />
                <MetricRow label="T_follow médio" value={fmtDur(metrics.avgFollowUpDuration)} />
                <MetricRow label="N_attempts médio" value={metrics.avgAttemptsToContact.toFixed(1)} />
                <MetricRow label="T_total por contato" value={metrics.tTotal > 0 ? `${(metrics.tTotal * 60).toFixed(0)} min` : '-'} />
                <MetricRow label="Margem/Hora" value={fmt(metrics.marginPerHour)} />
                <MetricRow label="Taxa de Contato" value={`${metrics.contactRate.toFixed(1)}%`} />
                <MetricRow label="Total de Ligações" value={String(metrics.totalCalls)} />
                <MetricRow label="Dados coletados" value={`${metrics.daysOfData} dias`} />
              </CardContent>
            </Card>
            {!metrics.hasEnoughData && (
              <Card className="border-dashed">
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground">
                    ⚡ Após <strong>30 dias</strong> de dados o sistema ajustará automaticamente os pesos.
                    Progresso: {metrics.daysOfData}/30 dias.
                  </p>
                  <Progress value={(metrics.daysOfData / 30) * 100} className="h-2 mt-2" />
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* LEARNING/IA TAB */}
          <TabsContent value="learning" className="space-y-3 mt-3">
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Brain className="w-4 h-4" /> Pesos do Health Score
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <WeightBar label="Recência/Frequência (RF)" value={config.health_w_rf * 100} />
                <WeightBar label="Monetário (M)" value={config.health_w_m * 100} />
                <WeightBar label="Margem Bruta (G)" value={config.health_w_g * 100} />
                <WeightBar label="Mix Categorias (X)" value={config.health_w_x * 100} />
                <WeightBar label="Atendimento (S)" value={config.health_w_s * 100} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Pesos do Priority Score
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <WeightBar label="Churn Risk" value={config.priority_w_churn * 100} />
                <WeightBar label="Recover Score" value={config.priority_w_recover * 100} />
                <WeightBar label="Expansion" value={config.priority_w_expansion * 100} />
                <WeightBar label="Efficiency" value={config.priority_w_eff * 100} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" /> Quotas da Agenda
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0 space-y-2">
                <WeightBar label="Risco/Recuperação" value={config.agenda_pct_risco * 100} color="bg-destructive" />
                <WeightBar label="Expansão" value={config.agenda_pct_expansao * 100} color="bg-emerald-500" />
                <WeightBar label="Follow-up" value={config.agenda_pct_followup * 100} color="bg-blue-500" />
              </CardContent>
            </Card>
            <Button variant="outline" className="w-full" onClick={() => navigate('/farmer/governance')}>
              <Shield className="w-4 h-4 mr-2" /> Propor Alteração de Pesos
            </Button>
          </TabsContent>
        </Tabs>
      </main>
      <BottomNav />
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────────────
const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className="text-sm font-semibold">{value}</span>
  </div>
);

const WeightBar = ({ label, value, color = 'bg-primary' }: { label: string; value: number; color?: string }) => (
  <div>
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs">{label}</span>
      <span className="text-xs font-semibold">{value.toFixed(0)}%</span>
    </div>
    <div className="w-full bg-muted rounded-full h-2">
      <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${value}%` }} />
    </div>
  </div>
);

const ClientDetail = ({ client, onBack, config }: { client: ClientScore; onBack: () => void; config: any }) => {
  const hc = healthColors[client.healthClass] || healthColors.critico;
  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-1">
        ← Voltar
      </Button>
      <Card className={`border-2 ${hc.border}`}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-semibold">{client.customer_name}</p>
              {client.customer_phone && <p className="text-xs text-muted-foreground">{client.customer_phone}</p>}
            </div>
            <div className={`px-3 py-1 rounded-full text-sm font-bold ${hc.bg} ${hc.text}`}>
              {client.healthScore.toFixed(0)}
            </div>
          </div>
          <p className="text-xs mb-3">{healthLabels[client.healthClass]}</p>

          <div className="grid grid-cols-5 gap-1 mb-4">
            {[
              { label: 'RF', value: client.rf },
              { label: 'M', value: client.m },
              { label: 'G', value: client.g },
              { label: 'X', value: client.x },
              { label: 'S', value: client.s },
            ].map(({ label, value }) => (
              <div key={label} className="text-center">
                <div className="w-full bg-muted rounded-full h-1.5 mb-1">
                  <div className="bg-primary h-1.5 rounded-full" style={{ width: `${value * 100}%` }} />
                </div>
                <p className="text-[9px] text-muted-foreground">{label}</p>
                <p className="text-[10px] font-semibold">{(value * 100).toFixed(0)}%</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 pb-2"><CardTitle className="text-sm">Priority Score</CardTitle></CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          <MetricRow label="Priority Score Total" value={client.priorityScore.toFixed(1)} />
          <MetricRow label="Churn Risk" value={`${client.churnRisk.toFixed(1)}%`} />
          <MetricRow label="Recover Score" value={client.recoverScore.toFixed(1)} />
          <MetricRow label="Expansion Score" value={client.expansionScore.toFixed(1)} />
          <MetricRow label="Efficiency Score" value={client.effScore.toFixed(1)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 pb-2"><CardTitle className="text-sm">Dados Brutos</CardTitle></CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          <MetricRow label="Dias sem compra" value={String(client.daysSinceLastPurchase)} />
          <MetricRow label="Intervalo médio recompra" value={`${client.avgRepurchaseInterval.toFixed(0)} dias`} />
          <MetricRow label="Gasto mensal (180d)" value={fmt(client.avgMonthlySpend180d)} />
          <MetricRow label="Margem bruta" value={`${client.grossMarginPct.toFixed(1)}%`} />
          <MetricRow label="Categorias compradas" value={String(client.categoryCount)} />
          <MetricRow label="Taxa resposta (60d)" value={`${client.answerRate60d.toFixed(1)}%`} />
          <MetricRow label="WhatsApp reply (60d)" value={`${client.whatsappReplyRate60d.toFixed(1)}%`} />
          <MetricRow label="Receita potencial atrasada" value={fmt(client.revenuePotential)} />
        </CardContent>
      </Card>
    </div>
  );
};

export default FarmerDashboard;
