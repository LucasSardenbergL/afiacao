import { useState, useMemo } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Target, MessageSquare, Brain, AlertTriangle, CheckCircle2,
  XCircle, HelpCircle, TrendingUp, Clock, Phone, ChevronDown,
  ChevronUp, Lightbulb, Search, Filter, Star, BarChart3,
  ArrowRight, Play, Mic, FileText, Zap, Award, Eye, EyeOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/* ─── Types ─── */
interface SPINQuestion {
  id: string;
  type: 'situation' | 'problem' | 'implication' | 'need-payoff';
  text: string;
  altText?: string;
  wasAsked: boolean;
  effectiveness?: number;
}

interface CallCoaching {
  id: string;
  customerName: string;
  date: string;
  duration: number;
  spinScore: { situation: number; problem: number; implication: number; needPayoff: number; total: number };
  highlights: string[];
  missedOpportunities: string[];
  suggestedQuestions: SPINQuestion[];
  feedback: string;
  callResult: string;
  marginGenerated: number;
}

/* ─── Mock Data ─── */
const mockCalls: CallCoaching[] = [
  {
    id: '1',
    customerName: 'Metalúrgica São Paulo',
    date: '2026-02-24T10:30:00',
    duration: 420,
    spinScore: { situation: 85, problem: 70, implication: 45, needPayoff: 60, total: 65 },
    highlights: [
      'Boa abertura com rapport — mencionou o último pedido do cliente',
      'Identificou necessidade de fresas de topo para nova linha de produção',
      'Usou dado de margem do cluster para justificar preço',
    ],
    missedOpportunities: [
      'Não explorou impacto financeiro da parada de máquina (Implication)',
      'Poderia ter perguntado sobre prazo de entrega do concorrente',
      'Faltou perguntar quantas peças por turno a nova linha processará',
    ],
    suggestedQuestions: [
      { id: 'q1', type: 'implication', text: 'Se a ferramenta quebrar no meio do turno, quanto tempo de parada isso gera?', wasAsked: false },
      { id: 'q2', type: 'implication', text: 'Qual o custo por hora de máquina parada na sua linha?', wasAsked: false },
      { id: 'q3', type: 'need-payoff', text: 'Se eu garantisse uma ferramenta que dura 30% mais, quanto isso representaria em economia mensal?', wasAsked: false },
      { id: 'q4', type: 'problem', text: 'Você tem tido problemas com a vida útil das ferramentas atuais?', wasAsked: true, effectiveness: 80 },
      { id: 'q5', type: 'situation', text: 'Quantos turnos por dia a máquina opera?', wasAsked: true, effectiveness: 90 },
    ],
    feedback: 'Ligação sólida com boa abertura e diagnóstico de situação. O ponto principal de melhoria é explorar mais as implicações financeiras antes de apresentar a proposta. Quando o cliente mencionou "o preço está alto", a melhor resposta seria uma pergunta de implicação sobre custo total de propriedade.',
    callResult: 'pedido_parcial',
    marginGenerated: 340,
  },
  {
    id: '2',
    customerName: 'Usinagem Precisão LTDA',
    date: '2026-02-24T14:15:00',
    duration: 280,
    spinScore: { situation: 90, problem: 85, implication: 75, needPayoff: 80, total: 82 },
    highlights: [
      'Excelente sequência SPIN completa',
      'Usou pergunta de implicação que levou o cliente a calcular o custo',
      'Cross-sell natural de pastilhas para inserto',
    ],
    missedOpportunities: [
      'Poderia ter explorado mais o volume mensal para dimensionar melhor a proposta',
    ],
    suggestedQuestions: [
      { id: 'q6', type: 'need-payoff', text: 'Se reduzíssemos o tempo de setup em 15min por troca, quantas trocas por mês isso impactaria?', wasAsked: true, effectiveness: 95 },
    ],
    feedback: 'Excelente ligação. Sequência SPIN bem executada. O cliente verbalizou a necessidade e o vendedor conectou com a solução de forma natural.',
    callResult: 'pedido_completo',
    marginGenerated: 890,
  },
];

const preCallQuestions: SPINQuestion[] = [
  { id: 'pre1', type: 'situation', text: 'Quantas máquinas CNC vocês operam atualmente?', wasAsked: false },
  { id: 'pre2', type: 'situation', text: 'Qual o volume médio de peças por turno?', wasAsked: false },
  { id: 'pre3', type: 'problem', text: 'Vocês têm enfrentado quebras inesperadas de ferramenta?', wasAsked: false },
  { id: 'pre4', type: 'problem', text: 'O que mais impacta a produtividade da linha hoje?', wasAsked: false },
  { id: 'pre5', type: 'implication', text: 'Quando uma ferramenta quebra, quanto tempo leva para retomar a produção?', wasAsked: false },
  { id: 'pre6', type: 'implication', text: 'Qual o custo de cada hora de máquina parada?', wasAsked: false },
  { id: 'pre7', type: 'need-payoff', text: 'Se pudéssemos reduzir essas paradas em 40%, quanto isso representaria em economia?', wasAsked: false },
  { id: 'pre8', type: 'need-payoff', text: 'Faria sentido um plano de reposição programada para evitar paradas?', wasAsked: false },
];

/* ─── Helpers ─── */
const spinTypeConfig: Record<string, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  situation: { label: 'Situação', color: 'text-blue-700', bgColor: 'bg-blue-50 border-blue-200', icon: HelpCircle },
  problem: { label: 'Problema', color: 'text-amber-700', bgColor: 'bg-amber-50 border-amber-200', icon: AlertTriangle },
  implication: { label: 'Implicação', color: 'text-red-700', bgColor: 'bg-red-50 border-red-200', icon: TrendingUp },
  'need-payoff': { label: 'Necessidade', color: 'text-emerald-700', bgColor: 'bg-emerald-50 border-emerald-200', icon: Target },
};

const resultConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  pedido_completo: { label: 'Pedido Completo', variant: 'default' },
  pedido_parcial: { label: 'Pedido Parcial', variant: 'secondary' },
  follow_up: { label: 'Follow-up', variant: 'secondary' },
  sem_interesse: { label: 'Sem Interesse', variant: 'destructive' },
};

const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
const fmtDuration = (s: number) => `${Math.floor(s / 60)}min ${s % 60}s`;

function ScoreGauge({ label, value, size = 'md' }: { label: string; value: number; size?: 'sm' | 'md' }) {
  const color = value >= 80 ? 'text-success' : value >= 60 ? 'text-warning' : 'text-destructive';
  const bgColor = value >= 80 ? 'bg-success/20' : value >= 60 ? 'bg-warning/20' : 'bg-destructive/20';
  return (
    <div className="text-center">
      <div className={cn(
        'rounded-full flex items-center justify-center mx-auto font-bold',
        bgColor, color,
        size === 'sm' ? 'w-10 h-10 text-sm' : 'w-14 h-14 text-lg'
      )}>
        {value}
      </div>
      <p className={cn('mt-1 text-muted-foreground', size === 'sm' ? 'text-2xs' : 'text-xs')}>{label}</p>
    </div>
  );
}

/* ─── Main Component ─── */
const CoachingSPIN = () => {
  const [activeTab, setActiveTab] = useState('post-call');
  const [selectedCall, setSelectedCall] = useState<CallCoaching | null>(mockCalls[0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    highlights: true, missed: true, questions: true, feedback: true,
  });

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const avgScore = useMemo(() => {
    if (mockCalls.length === 0) return 0;
    return Math.round(mockCalls.reduce((acc, c) => acc + c.spinScore.total, 0) / mockCalls.length);
  }, []);

  return (
    <AppShell>
      <div className="space-y-4">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Coaching SPIN</h1>
            <p className="text-sm text-muted-foreground">Análise e melhoria contínua das suas ligações de vendas</p>
          </div>
          <div className="hidden md:flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <Award className="w-3 h-3" />
              Score Médio: {avgScore}
            </Badge>
            <Badge variant="outline" className="gap-1">
              <Phone className="w-3 h-3" />
              {mockCalls.length} calls analisadas
            </Badge>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-2 w-full max-w-md">
            <TabsTrigger value="pre-call" className="gap-1.5 text-xs">
              <Lightbulb className="w-3.5 h-3.5" /> Pré-Call
            </TabsTrigger>
            <TabsTrigger value="post-call" className="gap-1.5 text-xs">
              <BarChart3 className="w-3.5 h-3.5" /> Pós-Call
            </TabsTrigger>
          </TabsList>

          {/* ─── PRE-CALL ─── */}
          <TabsContent value="pre-call" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-primary" />
                  Perguntas Sugeridas para Próxima Ligação
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Baseadas no perfil do cliente, histórico de compras e oportunidades identificadas.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(spinTypeConfig).map(([type, config]) => {
                  const questions = preCallQuestions.filter(q => q.type === type);
                  if (questions.length === 0) return null;
                  const TypeIcon = config.icon;
                  return (
                    <div key={type} className={cn('rounded-lg border p-3', config.bgColor)}>
                      <div className="flex items-center gap-2 mb-2">
                        <TypeIcon className={cn('w-4 h-4', config.color)} />
                        <span className={cn('text-xs font-semibold', config.color)}>{config.label}</span>
                        <Badge variant="outline" className="text-2xs ml-auto">{questions.length}</Badge>
                      </div>
                      <div className="space-y-1.5">
                        {questions.map(q => (
                          <div key={q.id} className="flex items-start gap-2 bg-background/60 rounded-md p-2">
                            <MessageSquare className="w-3 h-3 mt-0.5 text-muted-foreground shrink-0" />
                            <p className="text-xs leading-relaxed">{q.text}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Brain className="w-4 h-4 text-primary" />
                  Dicas Rápidas SPIN
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs font-semibold mb-1">🎯 Regra de ouro</p>
                    <p className="text-xs text-muted-foreground">Nunca apresente preço antes de estabelecer o custo do problema. O cliente precisa sentir a dor antes de ver o remédio.</p>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs font-semibold mb-1">📊 Sequência ideal</p>
                    <p className="text-xs text-muted-foreground">S → P → I → N. Gaste 40% do tempo em Implicação. É aqui que o cliente "calcula" o custo de não agir.</p>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs font-semibold mb-1">⚡ Erro mais comum</p>
                    <p className="text-xs text-muted-foreground">Pular direto de Problema para proposta. Sem Implicação, o cliente vê preço como custo, não investimento.</p>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs font-semibold mb-1">💡 Pergunta-chave</p>
                    <p className="text-xs text-muted-foreground">"Quanto custa cada vez que isso acontece?" — essa pergunta transforma percepção de preço em 90% dos casos.</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── POST-CALL ─── */}
          <TabsContent value="post-call" className="mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Call list */}
              <div className="lg:col-span-4 space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Buscar ligação..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="pl-9 h-8 text-xs"
                  />
                </div>

                {mockCalls.map(call => {
                  const res = resultConfig[call.callResult] || resultConfig.follow_up;
                  const isSelected = selectedCall?.id === call.id;
                  return (
                    <Card
                      key={call.id}
                      className={cn(
                        'cursor-pointer transition-all hover:shadow-sm',
                        isSelected && 'ring-2 ring-primary border-primary'
                      )}
                      onClick={() => setSelectedCall(call)}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-start justify-between mb-1.5">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{call.customerName}</p>
                            <p className="text-2xs text-muted-foreground">
                              {new Date(call.date).toLocaleDateString('pt-BR')} · {fmtDuration(call.duration)}
                            </p>
                          </div>
                          <Badge variant={res.variant} className="text-2xs shrink-0">{res.label}</Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-2">
                          <div className="flex items-center gap-1">
                            <Star className={cn('w-3 h-3', call.spinScore.total >= 80 ? 'text-success fill-success' : call.spinScore.total >= 60 ? 'text-warning fill-warning' : 'text-destructive fill-destructive')} />
                            <span className="text-xs font-semibold">{call.spinScore.total}</span>
                          </div>
                          <span className="text-2xs text-muted-foreground">{fmt(call.marginGenerated)} margem</span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Call detail */}
              <div className="lg:col-span-8 space-y-4">
                {selectedCall ? (
                  <>
                    {/* SPIN Score Card */}
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm">{selectedCall.customerName}</CardTitle>
                          <div className="flex gap-2">
                            <Badge variant="outline" className="text-2xs gap-1">
                              <Clock className="w-3 h-3" /> {fmtDuration(selectedCall.duration)}
                            </Badge>
                            <Badge variant="outline" className="text-2xs gap-1">
                              {fmt(selectedCall.marginGenerated)}
                            </Badge>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-center justify-around py-3">
                          <ScoreGauge label="Total" value={selectedCall.spinScore.total} />
                          <Separator orientation="vertical" className="h-12" />
                          <ScoreGauge label="S" value={selectedCall.spinScore.situation} size="sm" />
                          <ScoreGauge label="P" value={selectedCall.spinScore.problem} size="sm" />
                          <ScoreGauge label="I" value={selectedCall.spinScore.implication} size="sm" />
                          <ScoreGauge label="N" value={selectedCall.spinScore.needPayoff} size="sm" />
                        </div>
                        <div className="grid grid-cols-4 gap-1 mt-2">
                          {[
                            { label: 'Situação', value: selectedCall.spinScore.situation },
                            { label: 'Problema', value: selectedCall.spinScore.problem },
                            { label: 'Implicação', value: selectedCall.spinScore.implication },
                            { label: 'Necessidade', value: selectedCall.spinScore.needPayoff },
                          ].map(item => (
                            <div key={item.label}>
                              <div className="flex justify-between text-2xs mb-0.5">
                                <span className="text-muted-foreground">{item.label}</span>
                                <span className="font-medium">{item.value}%</span>
                              </div>
                              <Progress value={item.value} className="h-1.5" />
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Highlights */}
                    <Card>
                      <button
                        className="w-full flex items-center justify-between p-3"
                        onClick={() => toggleSection('highlights')}
                      >
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-success" />
                          <span className="text-sm font-medium">O que funcionou bem</span>
                          <Badge variant="outline" className="text-2xs">{selectedCall.highlights.length}</Badge>
                        </div>
                        {expandedSections.highlights ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      {expandedSections.highlights && (
                        <CardContent className="pt-0 pb-3">
                          <div className="space-y-1.5">
                            {selectedCall.highlights.map((h, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs bg-success/5 rounded-md p-2">
                                <CheckCircle2 className="w-3 h-3 text-success mt-0.5 shrink-0" />
                                <span>{h}</span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      )}
                    </Card>

                    {/* Missed Opportunities */}
                    <Card>
                      <button
                        className="w-full flex items-center justify-between p-3"
                        onClick={() => toggleSection('missed')}
                      >
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-warning" />
                          <span className="text-sm font-medium">O que faltou</span>
                          <Badge variant="outline" className="text-2xs">{selectedCall.missedOpportunities.length}</Badge>
                        </div>
                        {expandedSections.missed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      {expandedSections.missed && (
                        <CardContent className="pt-0 pb-3">
                          <div className="space-y-1.5">
                            {selectedCall.missedOpportunities.map((m, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs bg-warning/5 rounded-md p-2">
                                <AlertTriangle className="w-3 h-3 text-warning mt-0.5 shrink-0" />
                                <span>{m}</span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      )}
                    </Card>

                    {/* Suggested Questions */}
                    <Card>
                      <button
                        className="w-full flex items-center justify-between p-3"
                        onClick={() => toggleSection('questions')}
                      >
                        <div className="flex items-center gap-2">
                          <MessageSquare className="w-4 h-4 text-primary" />
                          <span className="text-sm font-medium">Melhores perguntas</span>
                          <Badge variant="outline" className="text-2xs">{selectedCall.suggestedQuestions.length}</Badge>
                        </div>
                        {expandedSections.questions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      {expandedSections.questions && (
                        <CardContent className="pt-0 pb-3">
                          <div className="space-y-2">
                            {selectedCall.suggestedQuestions.map(q => {
                              const cfg = spinTypeConfig[q.type];
                              const TypeIcon = cfg.icon;
                              return (
                                <div key={q.id} className={cn('rounded-lg border p-2.5', cfg.bgColor)}>
                                  <div className="flex items-center gap-2 mb-1">
                                    <TypeIcon className={cn('w-3 h-3', cfg.color)} />
                                    <span className={cn('text-2xs font-semibold', cfg.color)}>{cfg.label}</span>
                                    {q.wasAsked ? (
                                      <Badge className="text-2xs bg-success/10 text-success border-success/20 ml-auto">
                                        <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" /> Perguntou
                                      </Badge>
                                    ) : (
                                      <Badge className="text-2xs bg-muted text-muted-foreground ml-auto">
                                        <XCircle className="w-2.5 h-2.5 mr-0.5" /> Não usou
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-xs leading-relaxed">{q.text}</p>
                                  {q.effectiveness !== undefined && (
                                    <div className="flex items-center gap-1 mt-1">
                                      <span className="text-2xs text-muted-foreground">Efetividade:</span>
                                      <Progress value={q.effectiveness} className="h-1 flex-1 max-w-[100px]" />
                                      <span className="text-2xs font-medium">{q.effectiveness}%</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </CardContent>
                      )}
                    </Card>

                    {/* Feedback */}
                    <Card>
                      <button
                        className="w-full flex items-center justify-between p-3"
                        onClick={() => toggleSection('feedback')}
                      >
                        <div className="flex items-center gap-2">
                          <Brain className="w-4 h-4 text-primary" />
                          <span className="text-sm font-medium">Feedback objetivo</span>
                        </div>
                        {expandedSections.feedback ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      {expandedSections.feedback && (
                        <CardContent className="pt-0 pb-3">
                          <p className="text-xs leading-relaxed text-muted-foreground bg-muted/30 rounded-lg p-3">
                            {selectedCall.feedback}
                          </p>
                        </CardContent>
                      )}
                    </Card>
                  </>
                ) : (
                  <Card>
                    <CardContent className="p-8 text-center">
                      <Phone className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground">Selecione uma ligação para ver a análise SPIN</p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
};

export default CoachingSPIN;
