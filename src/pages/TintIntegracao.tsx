import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Plug,
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Store,
  Building2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";

const TintImport = lazy(() => import("./TintImport"));
const TintIntegrations = lazy(() => import("./TintIntegrations"));
const TintSyncRuns = lazy(() => import("./TintSyncRuns"));
const TintReconciliation = lazy(() => import("./TintReconciliation"));
const TintApiContract = lazy(() => import("./TintApiContract"));

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

function KpiCards({ empresa }: { empresa: string }) {
  void empresa;

  const { data } = useQuery({
    queryKey: ["tint-integracao-kpis", empresa],
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
      // TODO: tabela tint_integrations nao existe ainda; lojas ativas zerada
      return {
        total: total.count ?? 0,
        completos: completos.count ?? 0,
        erros: erros.count ?? 0,
        lojasAtivas: 0,
      };
    },
  });

  const cards = [
    { label: "Total Sync Runs", value: data?.total ?? 0, icon: RefreshCw },
    { label: "Completos", value: data?.completos ?? 0, icon: CheckCircle2 },
    { label: "Erros", value: data?.erros ?? 0, icon: AlertCircle },
    { label: "Lojas Ativas", value: data?.lojasAtivas ?? 0, icon: Store },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
  const tab = params.get("tab") ?? "importar";
  const [empresa, setEmpresa] = useState("OBEN");

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
              Importação, integrações de loja, execuções de sincronização e reconciliação tintométrica.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <Select value={empresa} onValueChange={setEmpresa}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Empresa" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OBEN">OBEN</SelectItem>
              <SelectItem value="COLACOR">COLACOR</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <KpiCards empresa={empresa} />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 sm:grid-cols-5 w-full">
          <TabsTrigger value="importar">Importar</TabsTrigger>
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
