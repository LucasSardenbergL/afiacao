import { useState } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useBundleEngine, type BundleRecommendation, type AssociationRule, type CustomerBundles } from '@/hooks/useBundleEngine';
import { useBundleArguments, classifyCustomerProfile, profileLabels, type CustomerProfile, type BundleArgument } from '@/hooks/useBundleArguments';
import { useDiagnosticQuestions, typeLabels, type QuestionWithResponse, type QuestionResponse } from '@/hooks/useDiagnosticQuestions';
import {
  Loader2, Package, RefreshCw, ChevronDown, ChevronUp,
  BarChart3, Layers, Zap, ArrowRight,
  Phone, Send, FileText, Sparkles, Copy, Check,
  HelpCircle, ThumbsUp, ThumbsDown, Minus, RotateCcw, Save
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FarmerBundles = () => {
  const { customerBundles, rules, loading, calculating, calculateBundles } = useBundleEngine();
  const { arguments: bundleArgs, generating: argGenerating, generateArgument } = useBundleArguments();
  const diagHook = useDiagnosticQuestions();
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  const totalLIE = customerBundles.reduce((s, c) => s + c.bundles.reduce((s2, b) => s2 + b.lieBundle, 0), 0);
  const totalBundles = customerBundles.reduce((s, c) => s + c.bundles.length, 0);

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Bundles Dinâmicos" showBack />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-primary" />
                <h2 className="text-sm font-bold">Bundles + IA Consultiva</h2>
              </div>
              <Button size="sm" onClick={() => calculateBundles()} disabled={calculating} className="h-7 text-[10px]">
                {calculating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                Calcular
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Bundles estatísticos + argumentação consultiva + perguntas diagnósticas SPIN por IA.
            </p>
          </CardContent>
        </Card>

        {/* KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <Card><CardContent className="p-2.5 text-center"><p className="text-lg font-bold">{rules.length}</p><p className="text-[9px] text-muted-foreground">Regras</p></CardContent></Card>
          <Card><CardContent className="p-2.5 text-center"><p className="text-lg font-bold">{totalBundles}</p><p className="text-[9px] text-muted-foreground">Bundles</p></CardContent></Card>
          <Card><CardContent className="p-2.5 text-center"><p className="text-lg font-bold text-emerald-700">{fmt(totalLIE)}</p><p className="text-[9px] text-muted-foreground">LIE Total</p></CardContent></Card>
        </div>

        <Tabs defaultValue="bundles" className="w-full">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="bundles" className="text-[10px]">Bundles por Cliente</TabsTrigger>
            <TabsTrigger value="rules" className="text-[10px]">Regras de Associação</TabsTrigger>
          </TabsList>

          <TabsContent value="bundles" className="space-y-3 mt-3">
            {loading && !customerBundles.length ? (
              <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
            ) : customerBundles.length === 0 ? (
              <Card><CardContent className="p-6 text-center"><Package className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-xs text-muted-foreground">Clique em "Calcular" para gerar bundles.</p></CardContent></Card>
            ) : (
              customerBundles.map(cb => (
                <CustomerBundleCard
                  key={cb.customerId}
                  data={cb}
                  expanded={expandedCustomer === cb.customerId}
                  onToggle={() => setExpandedCustomer(expandedCustomer === cb.customerId ? null : cb.customerId)}
                  bundleArgs={bundleArgs}
                  argGenerating={argGenerating}
                  onGenerateArgument={generateArgument}
                  diagHook={diagHook}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="rules" className="space-y-3 mt-3">
            {rules.length === 0 ? (
              <Card><CardContent className="p-6 text-center"><BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-xs text-muted-foreground">Nenhuma regra descoberta ainda.</p></CardContent></Card>
            ) : (
              <>
                <p className="text-[10px] text-muted-foreground">Top {rules.length} regras por Lift (mínimo 1.2)</p>
                {rules.slice(0, 20).map((rule, i) => <RuleCard key={i} rule={rule} />)}
              </>
            )}
          </TabsContent>
        </Tabs>
      </main>
      <BottomNav />
    </div>
  );
};

// ─── Customer Bundle Card ────────────────────────────────────────────
interface CustomerBundleCardProps {
  data: CustomerBundles;
  expanded: boolean;
  onToggle: () => void;
  bundleArgs: Record<string, BundleArgument>;
  argGenerating: Record<string, boolean>;
  onGenerateArgument: (key: string, bundle: any, customer: any, profile: CustomerProfile) => void;
  diagHook: ReturnType<typeof useDiagnosticQuestions>;
}

const CustomerBundleCard = ({ data, expanded, onToggle, bundleArgs, argGenerating, onGenerateArgument, diagHook }: CustomerBundleCardProps) => {
  const totalBundleLIE = data.bundles.reduce((s, b) => s + b.lieBundle, 0);
  const bestBundleLIE = data.bundles[0]?.lieBundle || 0;
  const individualLIE = data.bestIndividual?.lie || 0;
  const bundleWins = bestBundleLIE > individualLIE;

  const profile = classifyCustomerProfile(data.healthScore, data.avgMonthlySpend || 0, data.grossMarginPct || 0, data.categoryCount || 0);
  const profileInfo = profileLabels[profile];

  const customerCtx = {
    name: data.customerName,
    healthScore: data.healthScore,
    avgMonthlySpend: data.avgMonthlySpend,
    categoryCount: data.categoryCount,
    daysSinceLastPurchase: data.daysSinceLastPurchase,
    cnae: data.cnae,
    customerType: data.customerType,
    recentProducts: data.recentProducts,
  };

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between cursor-pointer" onClick={onToggle}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold truncate">{data.customerName}</span>
              <Badge variant="outline" className="text-[8px] shrink-0">HS {data.healthScore}</Badge>
              <span className="text-[9px] shrink-0" title={profileInfo.label}>{profileInfo.emoji}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground">{data.bundles.length} bundles</span>
              <span className="text-[10px] font-semibold text-emerald-700">LIE {fmt(totalBundleLIE)}</span>
              <Badge variant="outline" className={`text-[7px] ${profileInfo.color}`}>{profileInfo.label}</Badge>
            </div>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
        </div>

        {expanded && (
          <div className="mt-3 space-y-3">
            {/* Comparison */}
            <div className="bg-muted/50 rounded-lg p-2">
              <p className="text-[9px] font-semibold mb-1">📊 Comparação Inteligente</p>
              <div className="grid grid-cols-2 gap-2">
                <div className={`rounded p-1.5 text-center ${bundleWins ? 'bg-emerald-50 ring-1 ring-emerald-300' : 'bg-muted'}`}>
                  <Layers className="w-3 h-3 mx-auto mb-0.5 text-emerald-600" />
                  <p className="text-[9px] text-muted-foreground">Melhor Bundle</p>
                  <p className="text-xs font-bold">{fmt(bestBundleLIE)}</p>
                  {bundleWins && <Badge className="text-[7px] bg-emerald-600 mt-0.5">🏆 Vencedor</Badge>}
                </div>
                <div className={`rounded p-1.5 text-center ${!bundleWins ? 'bg-blue-50 ring-1 ring-blue-300' : 'bg-muted'}`}>
                  <Zap className="w-3 h-3 mx-auto mb-0.5 text-blue-600" />
                  <p className="text-[9px] text-muted-foreground">Melhor Individual</p>
                  <p className="text-xs font-bold">{fmt(individualLIE)}</p>
                  {!bundleWins && data.bestIndividual && <Badge className="text-[7px] bg-blue-600 mt-0.5">🏆 Vencedor</Badge>}
                </div>
              </div>
            </div>

            {/* Bundles */}
            {data.bundles.map((bundle, i) => {
              const bundleKey = `${data.customerId}_${i}`;
              return (
                <BundleCardFull
                  key={i}
                  bundle={bundle}
                  rank={i + 1}
                  bundleKey={bundleKey}
                  customerId={data.customerId}
                  customerCtx={customerCtx}
                  profile={profile}
                  argument={bundleArgs[bundleKey]}
                  isArgGenerating={argGenerating[bundleKey] || false}
                  onGenerateArg={() => onGenerateArgument(bundleKey, bundle, customerCtx, profile)}
                  questions={diagHook.questions[bundleKey] || []}
                  isQuestionsGenerating={diagHook.generating[bundleKey] || false}
                  onGenerateQuestions={() => diagHook.generateQuestions(bundleKey, bundle, customerCtx, profile)}
                  onSetResponse={(idx, resp, notes) => diagHook.setResponse(bundleKey, idx, resp, notes)}
                  onToggleAlt={(idx) => diagHook.toggleAlt(bundleKey, idx)}
                  onSaveQuestions={(offered, result, margin, time) =>
                    diagHook.saveQuestionsToDb(bundleKey, bundle.id, data.customerId, profile, offered, result, margin, time)
                  }
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Full Bundle Card ────────────────────────────────────────────────
interface BundleCardFullProps {
  bundle: BundleRecommendation;
  rank: number;
  bundleKey: string;
  customerId: string;
  customerCtx: any;
  profile: CustomerProfile;
  argument?: BundleArgument;
  isArgGenerating: boolean;
  onGenerateArg: () => void;
  questions: QuestionWithResponse[];
  isQuestionsGenerating: boolean;
  onGenerateQuestions: () => void;
  onSetResponse: (idx: number, resp: QuestionResponse, notes?: string) => void;
  onToggleAlt: (idx: number) => void;
  onSaveQuestions: (offered: boolean, result?: string, margin?: number, time?: number) => void;
}

const BundleCardFull = ({
  bundle, rank, bundleKey, customerId, argument, isArgGenerating, onGenerateArg,
  questions, isQuestionsGenerating, onGenerateQuestions, onSetResponse, onToggleAlt, onSaveQuestions,
}: BundleCardFullProps) => {
  const navigate = useNavigate();
  const [argTab, setArgTab] = useState<'phone' | 'whatsapp' | 'tecnica'>('phone');
  const [activeSection, setActiveSection] = useState<'none' | 'args' | 'questions'>('none');
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ title: 'Copiado!' });
    setTimeout(() => setCopied(false), 2000);
  };

  const getActiveText = () => {
    if (!argument) return '';
    if (argTab === 'phone') return argument.versao_phone;
    if (argTab === 'whatsapp') return argument.versao_whatsapp;
    return argument.versao_tecnica;
  };

  return (
    <div className="bg-muted/30 rounded-lg p-2.5 border">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[8px]">Bundle #{rank}</Badge>
          <Badge className="text-[8px] bg-primary/10 text-primary">{bundle.products.length} produtos</Badge>
        </div>
        <span className="text-xs font-bold text-emerald-700">{fmt(bundle.lieBundle)}</span>
      </div>

      {/* Products */}
      <div className="space-y-1 mb-2">
        {bundle.products.map((p, i) => (
          <div key={i} className="flex items-center justify-between bg-background rounded px-2 py-1">
            <span className="text-[10px] truncate flex-1">{p.name}</span>
            <span className="text-[10px] font-semibold text-emerald-700 ml-2">{fmt(p.margin)}</span>
          </div>
        ))}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-1 text-center mb-2">
        <div><p className="text-[8px] text-muted-foreground">Support</p><p className="text-[10px] font-semibold">{(bundle.support * 100).toFixed(1)}%</p></div>
        <div><p className="text-[8px] text-muted-foreground">Confidence</p><p className="text-[10px] font-semibold">{(bundle.confidence * 100).toFixed(1)}%</p></div>
        <div><p className="text-[8px] text-muted-foreground">Lift</p><p className="text-[10px] font-semibold">{bundle.lift.toFixed(2)}</p></div>
        <div><p className="text-[8px] text-muted-foreground">P(Bundle)</p><p className="text-[10px] font-semibold">{bundle.pBundle.toFixed(1)}%</p></div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5 mb-2">
        <Button
          size="sm"
          variant={activeSection === 'questions' ? 'default' : 'outline'}
          className="flex-1 h-7 text-[9px] gap-1"
          onClick={() => {
            if (activeSection === 'questions') { setActiveSection('none'); return; }
            setActiveSection('questions');
            if (!questions.length && !isQuestionsGenerating) onGenerateQuestions();
          }}
        >
          <HelpCircle className="w-3 h-3" /> Perguntas SPIN
        </Button>
        <Button
          size="sm"
          variant={activeSection === 'args' ? 'default' : 'outline'}
          className="flex-1 h-7 text-[9px] gap-1"
          onClick={() => {
            if (activeSection === 'args') { setActiveSection('none'); return; }
            setActiveSection('args');
            if (!argument && !isArgGenerating) onGenerateArg();
          }}
        >
          <Sparkles className="w-3 h-3" /> Argumentação
        </Button>
      </div>

      {/* ─── DIAGNOSTIC QUESTIONS ──────────────────────────────── */}
      {activeSection === 'questions' && (
        <div className="space-y-2">
          {isQuestionsGenerating && (
            <div className="flex items-center justify-center gap-2 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="text-[10px] text-muted-foreground">Gerando perguntas diagnósticas...</span>
            </div>
          )}

          {questions.length > 0 && (
            <div className="bg-background rounded-lg p-2 space-y-2">
              <p className="text-[9px] font-semibold flex items-center gap-1">
                <HelpCircle className="w-3 h-3 text-primary" /> Perguntas Diagnósticas SPIN
              </p>
              {questions.map((q, idx) => (
                <QuestionCard
                  key={idx}
                  question={q}
                  onSetResponse={(resp, notes) => onSetResponse(idx, resp, notes)}
                  onToggleAlt={() => onToggleAlt(idx)}
                />
              ))}

              {/* Save responses */}
              <div className="flex gap-1.5 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-7 text-[9px] gap-1"
                  onClick={() => onSaveQuestions(false)}
                >
                  <Save className="w-3 h-3" /> Salvar (sem oferta)
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-7 text-[9px] gap-1"
                  onClick={() => onSaveQuestions(true)}
                >
                  <Save className="w-3 h-3" /> Salvar (ofertou)
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── ARGUMENT SECTION ──────────────────────────────────── */}
      {activeSection === 'args' && (
        <div className="space-y-2">
          {isArgGenerating && (
            <div className="flex items-center justify-center gap-2 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="text-[10px] text-muted-foreground">Gerando argumentação...</span>
            </div>
          )}

          {argument && (
            <>
              <div className="bg-background rounded-lg p-2 space-y-1.5">
                <p className="text-[9px] font-semibold flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-primary" /> Argumentação IA
                </p>
                <ArgLine icon="🔍" label="Diagnóstico" text={argument.diagnostico} />
                <ArgLine icon="🔬" label="Insight Técnico" text={argument.insight_tecnico} />
                <ArgLine icon="⚙️" label="Benefício Operacional" text={argument.beneficio_operacional} />
                <ArgLine icon="💰" label="Benefício Econômico" text={argument.beneficio_economico} />
                <ArgLine icon="🛡️" label="Objeção Antecipada" text={argument.objecao_antecipada} />
              </div>

              <div className="bg-background rounded-lg p-2">
                <div className="flex items-center gap-1 mb-2">
                  <Button size="sm" variant={argTab === 'phone' ? 'default' : 'ghost'} className="h-6 text-[9px] gap-1 px-2" onClick={() => setArgTab('phone')}>
                    <Phone className="w-3 h-3" /> Ligação
                  </Button>
                  <Button size="sm" variant={argTab === 'whatsapp' ? 'default' : 'ghost'} className="h-6 text-[9px] gap-1 px-2" onClick={() => setArgTab('whatsapp')}>
                    <Send className="w-3 h-3" /> WhatsApp
                  </Button>
                  <Button size="sm" variant={argTab === 'tecnica' ? 'default' : 'ghost'} className="h-6 text-[9px] gap-1 px-2" onClick={() => setArgTab('tecnica')}>
                    <FileText className="w-3 h-3" /> Técnica
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[9px] gap-1 px-2 ml-auto" onClick={() => copyText(getActiveText())}>
                    {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                  </Button>
                </div>
                <div className="bg-muted/50 rounded p-2">
                  <p className="text-[10px] whitespace-pre-line leading-relaxed">{getActiveText()}</p>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Question Card ───────────────────────────────────────────────────
const QuestionCard = ({ question, onSetResponse, onToggleAlt }: {
  question: QuestionWithResponse;
  onSetResponse: (resp: QuestionResponse, notes?: string) => void;
  onToggleAlt: () => void;
}) => {
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(question.notes || '');
  const info = typeLabels[question.type] || { label: question.type, emoji: '❓', color: 'text-foreground' };
  const displayText = question.useAlt ? question.alt : question.main;

  const responseIcons: Record<QuestionResponse, { icon: typeof ThumbsUp; label: string; color: string }> = {
    interesse: { icon: ThumbsUp, label: 'Interesse', color: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
    objecao: { icon: ThumbsDown, label: 'Objeção', color: 'bg-red-100 text-red-700 border-red-300' },
    indiferenca: { icon: Minus, label: 'Indiferença', color: 'bg-muted text-muted-foreground border-border' },
  };

  return (
    <div className="border rounded-lg p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{info.emoji}</span>
          <span className={`text-[9px] font-bold uppercase ${info.color}`}>{info.label}</span>
        </div>
        <Button size="sm" variant="ghost" className="h-5 text-[8px] px-1.5 gap-0.5" onClick={onToggleAlt} title="Alternar variação">
          <RotateCcw className="w-2.5 h-2.5" /> Alt
        </Button>
      </div>

      <p className="text-[10px] leading-relaxed font-medium">"{displayText}"</p>
      <p className="text-[8px] text-muted-foreground italic">💡 {question.rationale}</p>

      {/* Response buttons */}
      <div className="flex items-center gap-1">
        {(Object.entries(responseIcons) as [QuestionResponse, typeof responseIcons[QuestionResponse]][]).map(([key, val]) => {
          const Icon = val.icon;
          const isActive = question.response === key;
          return (
            <Button
              key={key}
              size="sm"
              variant="outline"
              className={`h-6 text-[8px] gap-0.5 px-2 ${isActive ? val.color + ' border' : ''}`}
              onClick={() => {
                onSetResponse(key, notes);
                if (!showNotes) setShowNotes(true);
              }}
            >
              <Icon className="w-2.5 h-2.5" /> {val.label}
            </Button>
          );
        })}
      </div>

      {/* Notes */}
      {showNotes && (
        <Textarea
          placeholder="Notas da resposta..."
          className="text-[10px] h-12 resize-none"
          value={notes}
          onChange={e => {
            setNotes(e.target.value);
            onSetResponse(question.response || 'indiferenca', e.target.value);
          }}
        />
      )}
    </div>
  );
};

// ─── Small components ────────────────────────────────────────────────
const ArgLine = ({ icon, label, text }: { icon: string; label: string; text: string }) => (
  <div className="flex items-start gap-1.5">
    <span className="text-[10px] shrink-0">{icon}</span>
    <div>
      <span className="text-[8px] font-semibold text-muted-foreground uppercase">{label}</span>
      <p className="text-[10px] leading-tight">{text}</p>
    </div>
  </div>
);

const RuleCard = ({ rule }: { rule: AssociationRule }) => (
  <Card>
    <CardContent className="p-2.5">
      <div className="flex items-center gap-1 mb-1 flex-wrap">
        {rule.antecedentNames.map((n, i) => <Badge key={i} variant="outline" className="text-[8px]">{n}</Badge>)}
        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
        {rule.consequentNames.map((n, i) => <Badge key={i} className="text-[8px] bg-emerald-100 text-emerald-800">{n}</Badge>)}
      </div>
      <div className="flex gap-3 text-[9px]">
        <span>Sup: <strong>{(rule.support * 100).toFixed(1)}%</strong></span>
        <span>Conf: <strong>{(rule.confidence * 100).toFixed(1)}%</strong></span>
        <span>Lift: <strong>{rule.lift.toFixed(2)}</strong></span>
        <Badge variant="outline" className="text-[7px]">{rule.type === 'sequential' ? '⏱ Sequencial' : '🔗 Associação'}</Badge>
      </div>
    </CardContent>
  </Card>
);

export default FarmerBundles;
