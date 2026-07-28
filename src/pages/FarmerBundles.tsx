// Bundles + IA Consultiva — bundles estatísticos, argumentação e perguntas SPIN.
// Composição: useFarmerBundles (engines + totais) + CustomerBundleCard + RuleCard.
// God-component split de src/pages/FarmerBundles.tsx (comportamento 1:1).
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Package, RefreshCw, BarChart3 } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useFarmerBundles } from '@/components/farmer/bundles/useFarmerBundles';
import { CustomerBundleCard } from '@/components/farmer/bundles/CustomerBundleCard';
import { RuleCard } from '@/components/farmer/bundles/RuleCard';

const FarmerBundles = () => {
  const {
    customerBundles,
    rules,
    loading,
    calculating,
    calculateBundles,
    bundleArgs,
    argGenerating,
    generateArgument,
    diagHook,
    expandedCustomer,
    toggleCustomer,
    totalBundles,
  } = useFarmerBundles();

  return (
    <div className="min-h-screen bg-background pb-24">

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
          {/* "LIE Total" (soma em R$) saiu: sem custo no browser não há lucro esperado a somar. */}
          <Card><CardContent className="p-2.5 text-center"><p className="text-lg font-bold text-status-success">{customerBundles.length}</p><p className="text-[9px] text-muted-foreground">Clientes</p></CardContent></Card>
        </div>

        <Tabs defaultValue="bundles" className="w-full">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="bundles" className="text-[10px]">Bundles por Cliente</TabsTrigger>
            <TabsTrigger value="rules" className="text-[10px]">Regras de Associação</TabsTrigger>
          </TabsList>

          <TabsContent value="bundles" className="space-y-3 mt-3">
            {loading && !customerBundles.length ? (
              <PageSkeleton variant="list" />
            ) : customerBundles.length === 0 ? (
              <Card><CardContent className="p-6 text-center"><Package className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-xs text-muted-foreground">Clique em "Calcular" para gerar bundles.</p></CardContent></Card>
            ) : (
              customerBundles.map(cb => (
                <CustomerBundleCard
                  key={cb.customerId}
                  data={cb}
                  expanded={expandedCustomer === cb.customerId}
                  onToggle={() => toggleCustomer(cb.customerId)}
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
    </div>
  );
};

export default FarmerBundles;
