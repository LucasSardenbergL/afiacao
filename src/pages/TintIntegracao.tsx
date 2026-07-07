import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plug, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { supabase } from "@/integrations/supabase/client";

const TintImport = lazy(() => import("./TintImport"));
const TintIntegrations = lazy(() => import("./TintIntegrations"));
const TintSyncRuns = lazy(() => import("./TintSyncRuns"));
const TintReconciliation = lazy(() => import("./TintReconciliation"));
const TintApiContract = lazy(() => import("./TintApiContract"));

const TabFallback = () => <PageSkeleton variant="auto" />;

function KpiCards() {
  const { data } = useQuery({
    queryKey: ["tint-integracao-kpis"],
    queryFn: async () => {
      const [total, completos, erros] = await Promise.all([
        supabase.from("tint_sync_runs").select("id", { count: "exact", head: true }),
        supabase
          .from("tint_sync_runs")
          .select("id", { count: "exact", head: true })
          .eq("status", "complete"),
        supabase
          .from("tint_sync_runs")
          .select("id", { count: "exact", head: true })
          .eq("status", "error"),
      ]);
      return {
        total: total.count ?? 0,
        completos: completos.count ?? 0,
        erros: erros.count ?? 0,
      };
    },
  });

  const cards = [
    { label: "Total Sync Runs", value: data?.total ?? 0, icon: RefreshCw },
    { label: "Completos", value: data?.completos ?? 0, icon: CheckCircle2 },
    { label: "Erros", value: data?.erros ?? 0, icon: AlertCircle },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((c) => (
        <Card key={c.label} className="border-border">
          <CardContent className="pt-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-2xl font-bold mt-1">{c.value}</div>
            </div>
            <c.icon className="h-8 w-8 text-muted-foreground opacity-60" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function TintIntegracao() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "integracoes";

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <Plug className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Integração e Sync</h1>
            <p className="text-sm text-muted-foreground">
              Integrações de loja, execuções de sincronização e reconciliação tintométrica.
            </p>
          </div>
        </div>
      </header>

      <KpiCards />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 sm:grid-cols-5 w-full">
          <TabsTrigger value="importar">Produtos Omie</TabsTrigger>
          <TabsTrigger value="integracoes">Integrações</TabsTrigger>
          <TabsTrigger value="sync-runs">Sync Runs</TabsTrigger>
          <TabsTrigger value="reconciliacao">Reconciliação</TabsTrigger>
          <TabsTrigger value="api-contract">API Contract</TabsTrigger>
        </TabsList>

        <TabsContent value="importar" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintImport />
          </Suspense>
        </TabsContent>
        <TabsContent value="integracoes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintIntegrations />
          </Suspense>
        </TabsContent>
        <TabsContent value="sync-runs" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintSyncRuns />
          </Suspense>
        </TabsContent>
        <TabsContent value="reconciliacao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintReconciliation />
          </Suspense>
        </TabsContent>
        <TabsContent value="api-contract" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintApiContract />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
