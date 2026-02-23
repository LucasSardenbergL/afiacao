import { useState } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBundleEngine, type BundleRecommendation, type AssociationRule, type CustomerBundles } from '@/hooks/useBundleEngine';
import { useBundleArguments, classifyCustomerProfile, profileLabels, type CustomerProfile, type BundleArgument } from '@/hooks/useBundleArguments';
import {
  Loader2, Package, TrendingUp, RefreshCw, ChevronDown, ChevronUp,
  CheckCircle, XCircle, DollarSign, BarChart3, Layers, Zap, ArrowRight,
  MessageSquare, Phone, Send, FileText, Sparkles, Copy, Check
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FarmerBundles = () => {
  const { customerBundles, rules, loading, calculating, calculateBundles } = useBundleEngine();
  const { arguments: bundleArgs, generating, generateArgument } = useBundleArguments();
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
                <h2 className="text-sm font-bold">Motor de Bundles + IA Consultiva</h2>
              </div>
              <Button size="sm" onClick={() => calculateBundles()} disabled={calculating} className="h-7 text-[10px]">
                {calculating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                Calcular
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Bundles baseados em padrões estatísticos + argumentação consultiva personalizada por IA.
            </p>
          </CardContent>
        </Card>

        {/* KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <Card>
            <CardContent className="p-2.5 text-center">
              <p className="text-lg font-bold">{rules.length}</p>
              <p className="text-[9px] text-muted-foreground">Regras</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2.5 text-center">
              <p className="text-lg font-bold">{totalBundles}</p>
              <p className="text-[9px] text-muted-foreground">Bundles</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-2.5 text-center">
              <p className="text-lg font-bold text-emerald-700">{fmt(totalLIE)}</p>
              <p className="text-[9px] text-muted-foreground">LIE Total</p>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="bundles" className="w-full">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="bundles" className="text-[10px]">Bundles por Cliente</TabsTrigger>
            <TabsTrigger value="rules" className="text-[10px]">Regras de Associação</TabsTrigger>
          </TabsList>

          <TabsContent value="bundles" className="space-y-3 mt-3">
            {loading && !customerBundles.length ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : customerBundles.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center">
                  <Package className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-xs text-muted-foreground">Clique em "Calcular" para gerar bundles baseados em padrões de compra.</p>
                </CardContent>
              </Card>
            ) : (
              customerBundles.map(cb => (
                <CustomerBundleCard
                  key={cb.customerId}
                  data={cb}
                  expanded={expandedCustomer === cb.customerId}
                  onToggle={() => setExpandedCustomer(expandedCustomer === cb.customerId ? null : cb.customerId)}
                  bundleArgs={bundleArgs}
                  generating={generating}
                  onGenerateArgument={generateArgument}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="rules" className="space-y-3 mt-3">
            {rules.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center">
                  <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-xs text-muted-foreground">Nenhuma regra de associação descoberta ainda.</p>
                </CardContent>
              </Card>
            ) : (
              <>
                <p className="text-[10px] text-muted-foreground">Top {rules.length} regras por Lift (mínimo 1.2)</p>
                {rules.slice(0, 20).map((rule, i) => (
                  <RuleCard key={i} rule={rule} />
                ))}
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
const CustomerBundleCard = ({ data, expanded, onToggle, bundleArgs, generating, onGenerateArgument }: {
  data: CustomerBundles;
  expanded: boolean;
  onToggle: () => void;
  bundleArgs: Record<string, BundleArgument>;
  generating: Record<string, boolean>;
  onGenerateArgument: (key: string, bundle: any, customer: any, profile: CustomerProfile) => void;
}) => {
  const totalBundleLIE = data.bundles.reduce((s, b) => s + b.lieBundle, 0);
  const bestBundleLIE = data.bundles[0]?.lieBundle || 0;
  const individualLIE = data.bestIndividual?.lie || 0;
  const bundleWins = bestBundleLIE > individualLIE;

  // Classify customer profile
  const profile = classifyCustomerProfile(
    data.healthScore,
    (data as any).avgMonthlySpend || 0,
    (data as any).grossMarginPct || 0,
    (data as any).categoryCount || 0
  );
  const profileInfo = profileLabels[profile];

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

            {/* Bundles with arguments */}
            {data.bundles.map((bundle, i) => {
              const bundleKey = `${data.customerId}_${i}`;
              return (
                <BundleCardWithArgument
                  key={i}
                  bundle={bundle}
                  rank={i + 1}
                  bundleKey={bundleKey}
                  argument={bundleArgs[bundleKey]}
                  isGenerating={generating[bundleKey] || false}
                  onGenerate={() => onGenerateArgument(
                    bundleKey,
                    bundle,
                    {
                      name: data.customerName,
                      healthScore: data.healthScore,
                      avgMonthlySpend: (data as any).avgMonthlySpend,
                      categoryCount: (data as any).categoryCount,
                      daysSinceLastPurchase: (data as any).daysSinceLastPurchase,
                      cnae: (data as any).cnae,
                      customerType: (data as any).customerType,
                    },
                    profile
                  )}
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Bundle Card with Argument ───────────────────────────────────────
const BundleCardWithArgument = ({ bundle, rank, bundleKey, argument, isGenerating, onGenerate }: {
  bundle: BundleRecommendation;
  rank: number;
  bundleKey: string;
  argument?: BundleArgument;
  isGenerating: boolean;
  onGenerate: () => void;
}) => {
  const [argTab, setArgTab] = useState<'phone' | 'whatsapp' | 'tecnica'>('phone');
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
        <div>
          <p className="text-[8px] text-muted-foreground">Support</p>
          <p className="text-[10px] font-semibold">{(bundle.support * 100).toFixed(1)}%</p>
        </div>
        <div>
          <p className="text-[8px] text-muted-foreground">Confidence</p>
          <p className="text-[10px] font-semibold">{(bundle.confidence * 100).toFixed(1)}%</p>
        </div>
        <div>
          <p className="text-[8px] text-muted-foreground">Lift</p>
          <p className="text-[10px] font-semibold">{bundle.lift.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-[8px] text-muted-foreground">P(Bundle)</p>
          <p className="text-[10px] font-semibold">{bundle.pBundle.toFixed(1)}%</p>
        </div>
      </div>

      {/* AI Argument Section */}
      {!argument && !isGenerating && (
        <Button
          size="sm"
          variant="outline"
          className="w-full h-8 text-[10px] gap-1"
          onClick={onGenerate}
        >
          <Sparkles className="w-3 h-3" />
          Gerar Argumentação Consultiva por IA
        </Button>
      )}

      {isGenerating && (
        <div className="flex items-center justify-center gap-2 py-3">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-[10px] text-muted-foreground">Gerando argumentação personalizada...</span>
        </div>
      )}

      {argument && (
        <div className="mt-2 space-y-2">
          {/* Diagnostic cards */}
          <div className="bg-background rounded-lg p-2 space-y-1.5">
            <p className="text-[9px] font-semibold flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-primary" /> Argumentação IA
            </p>
            <div className="space-y-1">
              <ArgLine icon="🔍" label="Diagnóstico" text={argument.diagnostico} />
              <ArgLine icon="🔬" label="Insight Técnico" text={argument.insight_tecnico} />
              <ArgLine icon="⚙️" label="Benefício Operacional" text={argument.beneficio_operacional} />
              <ArgLine icon="💰" label="Benefício Econômico" text={argument.beneficio_economico} />
              <ArgLine icon="🛡️" label="Objeção Antecipada" text={argument.objecao_antecipada} />
            </div>
          </div>

          {/* Format tabs */}
          <div className="bg-background rounded-lg p-2">
            <div className="flex items-center gap-1 mb-2">
              <Button
                size="sm"
                variant={argTab === 'phone' ? 'default' : 'ghost'}
                className="h-6 text-[9px] gap-1 px-2"
                onClick={() => setArgTab('phone')}
              >
                <Phone className="w-3 h-3" /> Ligação
              </Button>
              <Button
                size="sm"
                variant={argTab === 'whatsapp' ? 'default' : 'ghost'}
                className="h-6 text-[9px] gap-1 px-2"
                onClick={() => setArgTab('whatsapp')}
              >
                <Send className="w-3 h-3" /> WhatsApp
              </Button>
              <Button
                size="sm"
                variant={argTab === 'tecnica' ? 'default' : 'ghost'}
                className="h-6 text-[9px] gap-1 px-2"
                onClick={() => setArgTab('tecnica')}
              >
                <FileText className="w-3 h-3" /> Técnica
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] gap-1 px-2 ml-auto"
                onClick={() => copyText(getActiveText())}
              >
                {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
              </Button>
            </div>
            <div className="bg-muted/50 rounded p-2">
              <p className="text-[10px] whitespace-pre-line leading-relaxed">{getActiveText()}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Argument Line ───────────────────────────────────────────────────
const ArgLine = ({ icon, label, text }: { icon: string; label: string; text: string }) => (
  <div className="flex items-start gap-1.5">
    <span className="text-[10px] shrink-0">{icon}</span>
    <div>
      <span className="text-[8px] font-semibold text-muted-foreground uppercase">{label}</span>
      <p className="text-[10px] leading-tight">{text}</p>
    </div>
  </div>
);

// ─── Rule Card ───────────────────────────────────────────────────────
const RuleCard = ({ rule }: { rule: AssociationRule }) => (
  <Card>
    <CardContent className="p-2.5">
      <div className="flex items-center gap-1 mb-1 flex-wrap">
        {rule.antecedentNames.map((n, i) => (
          <Badge key={i} variant="outline" className="text-[8px]">{n}</Badge>
        ))}
        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
        {rule.consequentNames.map((n, i) => (
          <Badge key={i} className="text-[8px] bg-emerald-100 text-emerald-800">{n}</Badge>
        ))}
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
