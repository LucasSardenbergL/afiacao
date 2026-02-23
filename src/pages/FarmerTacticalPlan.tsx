import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useTacticalPlan, getObjectiveLabel, type TacticalPlan } from '@/hooks/useTacticalPlan';
import { supabase } from '@/integrations/supabase/client';
import {
  Loader2, Target, Heart, AlertTriangle, TrendingUp, Package,
  MessageSquare, Shield, Copy, Check, ChevronDown, ChevronUp,
  Plus, FileText, Brain, DollarSign, Clock, Zap
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

// ─── Helpers ───────────────────────────────────────────────────────
const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const objectiveColors: Record<string, string> = {
  recuperacao: 'bg-red-100 text-red-800',
  expansao_mix: 'bg-emerald-100 text-emerald-800',
  upsell_premium: 'bg-blue-100 text-blue-800',
  reativacao: 'bg-amber-100 text-amber-800',
  consolidacao_margem: 'bg-orange-100 text-orange-800',
};

const profileLabels: Record<string, string> = {
  sensivel_preco: '💰 Sensível a Preço',
  orientado_qualidade: '⭐ Orientado a Qualidade',
  orientado_produtividade: '⚡ Orientado a Produtividade',
  misto: '🔄 Perfil Misto',
};

const FarmerTacticalPlan = () => {
  const navigate = useNavigate();
  const { user, isStaff } = useAuth();
  const { toast } = useToast();
  const { plans, loading, generating, loadPlans, generatePlan, recordResult } = useTacticalPlan();
  const [customers, setCustomers] = useState<{ id: string; name: string; healthScore: number; churnRisk: number }[]>([]);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  useEffect(() => {
    if (user?.id && isStaff) {
      loadPlans();
      loadCustomers();
    }
  }, [user, isStaff]);

  const loadCustomers = async () => {
    if (!user?.id) return;
    const { data: scores } = await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, health_score, churn_risk')
      .eq('farmer_id', user.id)
      .order('priority_score', { ascending: false }) as any;
    if (!scores?.length) return;

    const ids = scores.map((s: any) => s.customer_user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, name')
      .in('user_id', ids) as any;

    const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p.name]));

    setCustomers(scores.map((s: any) => ({
      id: s.customer_user_id,
      name: profileMap.get(s.customer_user_id) || 'Cliente',
      healthScore: Number(s.health_score || 0),
      churnRisk: Number(s.churn_risk || 0),
    })));
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Plano Tático Pré-Ligação" showBack />

      <main className="px-4 py-4 space-y-3 max-w-lg mx-auto">
        {/* Header */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Target className="w-5 h-5 text-primary" />
              <h2 className="text-sm font-bold">PTPL — Plano Tático Pré-Ligação</h2>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Estratégia personalizada antes de cada ligação para maximizar lucro incremental.
            </p>
          </CardContent>
        </Card>

        {/* Generate for customer */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs flex items-center gap-2">
              <Plus className="w-3 h-3" /> Gerar Plano Tático
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            <p className="text-[10px] text-muted-foreground">
              Selecione um cliente prioritário para gerar o plano automaticamente.
            </p>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {customers.slice(0, 10).map(c => (
                <div key={c.id} className="flex items-center justify-between p-2 rounded-lg border text-xs">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${
                      c.healthScore >= 70 ? 'bg-emerald-500' :
                      c.healthScore >= 40 ? 'bg-amber-500' : 'bg-red-500'
                    }`} />
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="text-[9px] text-muted-foreground shrink-0">HS:{Math.round(c.healthScore)}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[9px] ml-2 shrink-0"
                    disabled={generating === c.id}
                    onClick={() => generatePlan(c.id)}
                  >
                    {generating === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Gerar'}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Plans List */}
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : plans.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs text-muted-foreground">Nenhum plano tático gerado ainda.</p>
            </CardContent>
          </Card>
        ) : (
          plans.map(plan => (
            <PlanCard
              key={plan.id}
              plan={plan}
              expanded={expandedPlan === plan.id}
              onToggle={() => setExpandedPlan(expandedPlan === plan.id ? null : plan.id)}
              onCopy={handleCopy}
              copiedText={copiedText}
              onRecordResult={recordResult}
            />
          ))
        )}
      </main>

      <BottomNav />
    </div>
  );
};

// ─── Plan Card Component ────────────────────────────────────────────
const PlanCard = ({
  plan, expanded, onToggle, onCopy, copiedText, onRecordResult,
}: {
  plan: TacticalPlan;
  expanded: boolean;
  onToggle: () => void;
  onCopy: (text: string) => void;
  copiedText: string | null;
  onRecordResult: (planId: string, result: any) => Promise<void>;
}) => {
  return (
    <Card className={plan.status === 'concluido' ? 'opacity-70' : ''}>
      {/* Header - always visible */}
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2" onClick={onToggle} role="button">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Target className="w-4 h-4 text-primary shrink-0" />
            <span className="text-xs font-bold truncate">{plan.customerName}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge className={`text-[8px] ${objectiveColors[plan.strategicObjective] || ''}`}>
              {getObjectiveLabel(plan.strategicObjective)}
            </Badge>
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </div>
        </div>

        {/* Quick metrics */}
        <div className="grid grid-cols-4 gap-1 text-center text-[9px]">
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{Math.round(plan.healthScore)}</p>
            <p className="text-muted-foreground">Health</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{Math.round(plan.churnRisk)}%</p>
            <p className="text-muted-foreground">Churn</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{plan.mixGap}</p>
            <p className="text-muted-foreground">Gap Mix</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="font-bold">{fmt(plan.bundleLie)}</p>
            <p className="text-muted-foreground">LIE</p>
          </div>
        </div>

        {/* Expanded content */}
        {expanded && (
          <div className="mt-3 space-y-3">
            {/* Diagnosis */}
            <Section title="Diagnóstico Resumido" icon={Heart}>
              <MetricRow label="Margem atual" value={`${plan.currentMarginPct.toFixed(1)}%`} />
              <MetricRow label="Média cluster" value={`${plan.clusterAvgMarginPct.toFixed(1)}%`} />
              <MetricRow label="Potencial expansão" value={`${plan.expansionPotential.toFixed(0)}%`} />
              <MetricRow label="Perfil" value={profileLabels[plan.customerProfile] || plan.customerProfile} />
            </Section>

            {/* Strategy */}
            {plan.approachStrategy && (
              <Section title="Estratégia de Abordagem" icon={Brain}>
                <p className="text-xs leading-relaxed">{plan.approachStrategy}</p>
                <CopyButton text={plan.approachStrategy} copied={copiedText === plan.approachStrategy} onCopy={onCopy} />
              </Section>
            )}

            {/* Bundle */}
            {plan.bundleLie > 0 && (
              <Section title="Bundle Prioritário" icon={Package}>
                <MetricRow label="LIE Bundle" value={fmt(plan.bundleLie)} />
                <MetricRow label="Probabilidade" value={`${plan.bundleProbability.toFixed(1)}%`} />
                <MetricRow label="Margem incremental" value={fmt(plan.bundleIncrementalMargin)} />
                {plan.bestIndividualLie > 0 && (
                  <MetricRow label="Melhor individual" value={fmt(plan.bestIndividualLie)} />
                )}
              </Section>
            )}

            {/* Diagnostic Questions */}
            {plan.diagnosticQuestions.length > 0 && (
              <Section title="Perguntas Diagnósticas" icon={MessageSquare}>
                {plan.diagnosticQuestions.map((q, i) => (
                  <div key={i} className="p-2 rounded bg-muted/30 space-y-0.5">
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium">
                        <span className="text-primary">{i + 1}.</span> {q.question}
                      </p>
                      <CopyButton text={q.question} copied={copiedText === q.question} onCopy={onCopy} />
                    </div>
                    <p className="text-[9px] text-muted-foreground">💡 {q.purpose}</p>
                  </div>
                ))}

                {plan.implicationQuestion && (
                  <div className="p-2 rounded bg-amber-50 border border-amber-200">
                    <div className="flex items-start justify-between gap-1">
                      <div>
                        <p className="text-[9px] font-semibold text-amber-700">Pergunta de Implicação</p>
                        <p className="text-xs">{plan.implicationQuestion}</p>
                      </div>
                      <CopyButton text={plan.implicationQuestion} copied={copiedText === plan.implicationQuestion} onCopy={onCopy} />
                    </div>
                  </div>
                )}

                {plan.offerTransition && (
                  <div className="p-2 rounded bg-emerald-50 border border-emerald-200">
                    <div className="flex items-start justify-between gap-1">
                      <div>
                        <p className="text-[9px] font-semibold text-emerald-700">Transição para Oferta</p>
                        <p className="text-xs">{plan.offerTransition}</p>
                      </div>
                      <CopyButton text={plan.offerTransition} copied={copiedText === plan.offerTransition} onCopy={onCopy} />
                    </div>
                  </div>
                )}
              </Section>
            )}

            {/* Objections */}
            {plan.probableObjections.length > 0 && (
              <Section title="Mapa de Objeções" icon={Shield}>
                {plan.probableObjections.map((obj, i) => (
                  <div key={i} className="p-2 rounded bg-muted/30 space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-red-700">⚠ {obj.objection}</p>
                      <Badge variant="outline" className="text-[8px]">{obj.probability}%</Badge>
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-start gap-1">
                        <span className="text-[9px] font-semibold text-blue-700 shrink-0">Técnica:</span>
                        <p className="text-[10px]">{obj.technical_response}</p>
                      </div>
                      <div className="flex items-start gap-1">
                        <span className="text-[9px] font-semibold text-emerald-700 shrink-0">Econômica:</span>
                        <p className="text-[10px]">{obj.economic_response}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {/* Post-call registration */}
            {plan.status !== 'concluido' && (
              <RecordResultDialog planId={plan.id} onRecord={onRecordResult} />
            )}

            {plan.status === 'concluido' && (
              <div className="p-2 rounded bg-muted/50 text-[10px] space-y-0.5">
                <p className="font-semibold">Resultado registrado</p>
                <p>Plano seguido: {plan.planFollowed ? 'Sim' : 'Não'}</p>
                <p>Resultado: {plan.callResult}</p>
                {plan.actualMargin !== undefined && <p>Margem: {fmt(plan.actualMargin)}</p>}
                {plan.callDurationSeconds && <p>Duração: {Math.round(plan.callDurationSeconds / 60)}min</p>}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Sub-components ─────────────────────────────────────────────────
const Section = ({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) => (
  <div className="space-y-1.5">
    <div className="flex items-center gap-1.5">
      <Icon className="w-3 h-3 text-primary" />
      <span className="text-[10px] font-semibold">{title}</span>
    </div>
    <div className="space-y-1.5 pl-4">{children}</div>
  </div>
);

const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between text-[10px]">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

const CopyButton = ({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: (t: string) => void }) => (
  <Button size="sm" variant="ghost" className="h-5 w-5 p-0 shrink-0" onClick={() => onCopy(text)}>
    {copied ? <Check className="w-2.5 h-2.5 text-emerald-600" /> : <Copy className="w-2.5 h-2.5" />}
  </Button>
);

// ─── Record Result Dialog ───────────────────────────────────────────
const RecordResultDialog = ({
  planId,
  onRecord,
}: {
  planId: string;
  onRecord: (planId: string, result: any) => Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [planFollowed, setPlanFollowed] = useState(true);
  const [callResult, setCallResult] = useState('');
  const [actualMargin, setActualMargin] = useState('');
  const [duration, setDuration] = useState('');
  const [objectionType, setObjectionType] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onRecord(planId, {
      planFollowed,
      callResult,
      actualMargin: parseFloat(actualMargin) || 0,
      callDurationSeconds: (parseFloat(duration) || 0) * 60,
      objectionType: objectionType || undefined,
      notes: notes || undefined,
    });
    setSaving(false);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full text-[10px] gap-1">
          <FileText className="w-3 h-3" /> Registrar Resultado
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Resultado da Ligação</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch checked={planFollowed} onCheckedChange={setPlanFollowed} />
            <Label className="text-xs">Plano foi seguido</Label>
          </div>

          <Select value={callResult} onValueChange={setCallResult}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Resultado" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="venda_realizada" className="text-xs">Venda realizada</SelectItem>
              <SelectItem value="interesse_futuro" className="text-xs">Interesse futuro</SelectItem>
              <SelectItem value="sem_interesse" className="text-xs">Sem interesse</SelectItem>
              <SelectItem value="nao_atendeu" className="text-xs">Não atendeu</SelectItem>
              <SelectItem value="reagendado" className="text-xs">Reagendado</SelectItem>
            </SelectContent>
          </Select>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px]">Margem (R$)</Label>
              <Input type="number" value={actualMargin} onChange={e => setActualMargin(e.target.value)} className="h-8 text-xs" placeholder="0.00" />
            </div>
            <div>
              <Label className="text-[10px]">Duração (min)</Label>
              <Input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="h-8 text-xs" placeholder="0" />
            </div>
          </div>

          <Select value={objectionType} onValueChange={setObjectionType}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Tipo de objeção (opcional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="preco" className="text-xs">Preço</SelectItem>
              <SelectItem value="tecnica" className="text-xs">Técnica</SelectItem>
              <SelectItem value="urgencia" className="text-xs">Falta de urgência</SelectItem>
              <SelectItem value="concorrente" className="text-xs">Concorrente</SelectItem>
              <SelectItem value="nenhuma" className="text-xs">Nenhuma</SelectItem>
            </SelectContent>
          </Select>

          <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observações..." className="text-xs min-h-[60px]" />

          <Button onClick={handleSave} disabled={!callResult || saving} className="w-full text-xs">
            {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Salvar Resultado
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FarmerTacticalPlan;
