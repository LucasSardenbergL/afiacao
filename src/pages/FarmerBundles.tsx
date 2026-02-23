import { useState } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBundleEngine, type BundleRecommendation, type AssociationRule, type CustomerBundles } from '@/hooks/useBundleEngine';
import {
  Loader2, Package, TrendingUp, RefreshCw, ChevronDown, ChevronUp,
  CheckCircle, XCircle, DollarSign, BarChart3, Layers, Zap, ArrowRight
} from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FarmerBundles = () => {
  const { customerBundles, rules, loading, calculating, calculateBundles } = useBundleEngine();
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  const totalLIE = customerBundles.reduce((s, c) => s + c.bundles.reduce((s2, b) => s2 + b.lieBundle, 0), 0);
  const totalBundles = customerBundles.reduce((s, c) => s + c.bundles.length, 0);

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Bundles Dinâmicos" showBack />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {/* Header */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-primary" />
                <h2 className="text-sm font-bold">Motor de Bundles Dinâmicos</h2>
              </div>
              <Button size="sm" onClick={() => calculateBundles()} disabled={calculating} className="h-7 text-[10px]">
                {calculating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                Calcular
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Gera bundles baseados em padrões estatísticos de compra para maximizar LIE por conversa.
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

          {/* ─── BUNDLES TAB ─────────────────────────────────────── */}
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
                />
              ))
            )}
          </TabsContent>

          {/* ─── RULES TAB ───────────────────────────────────────── */}
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
                <p className="text-[10px] text-muted-foreground">Top {rules.length} regras por Lift (mínimo {1.2})</p>
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

// ─── Sub-components ──────────────────────────────────────────────────
const CustomerBundleCard = ({ data, expanded, onToggle }: {
  data: CustomerBundles;
  expanded: boolean;
  onToggle: () => void;
}) => {
  const totalBundleLIE = data.bundles.reduce((s, b) => s + b.lieBundle, 0);
  const bestBundleLIE = data.bundles[0]?.lieBundle || 0;
  const individualLIE = data.bestIndividual?.lie || 0;
  const bundleWins = bestBundleLIE > individualLIE;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between cursor-pointer" onClick={onToggle}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold truncate">{data.customerName}</span>
              <Badge variant="outline" className="text-[8px] shrink-0">HS {data.healthScore}</Badge>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground">{data.bundles.length} bundles</span>
              <span className="text-[10px] font-semibold text-emerald-700">LIE {fmt(totalBundleLIE)}</span>
            </div>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
        </div>

        {expanded && (
          <div className="mt-3 space-y-3">
            {/* Comparison: Bundle vs Individual */}
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
              {data.bestIndividual && (
                <p className="text-[9px] text-muted-foreground mt-1">
                  Individual: {data.bestIndividual.productName} ({data.bestIndividual.type === 'cross_sell' ? 'Cross' : 'Up'})
                </p>
              )}
            </div>

            {/* Bundles */}
            {data.bundles.map((bundle, i) => (
              <BundleCard key={i} bundle={bundle} rank={i + 1} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const BundleCard = ({ bundle, rank }: { bundle: BundleRecommendation; rank: number }) => (
  <div className="bg-muted/30 rounded-lg p-2.5 border">
    <div className="flex items-center justify-between mb-1.5">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-[8px]">Bundle #{rank}</Badge>
        <Badge className="text-[8px] bg-primary/10 text-primary">{bundle.products.length} produtos</Badge>
      </div>
      <span className="text-xs font-bold text-emerald-700">{fmt(bundle.lieBundle)}</span>
    </div>

    {/* Products in bundle */}
    <div className="space-y-1 mb-2">
      {bundle.products.map((p, i) => (
        <div key={i} className="flex items-center justify-between bg-background rounded px-2 py-1">
          <span className="text-[10px] truncate flex-1">{p.name}</span>
          <span className="text-[10px] font-semibold text-emerald-700 ml-2">{fmt(p.margin)}</span>
        </div>
      ))}
    </div>

    {/* Metrics */}
    <div className="grid grid-cols-4 gap-1 text-center">
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
  </div>
);

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
