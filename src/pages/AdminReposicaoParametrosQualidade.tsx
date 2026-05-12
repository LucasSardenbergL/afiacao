import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Settings, Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Reaproveita as 4 telas originais — mesmas queries Supabase, sem duplicar.
// Tabelas/views usadas:
//  - sku_parametros + vw_revisao_parametros  → AdminReposicaoRevisao
//  - sku_parametros_historico                → AdminReposicaoHistorico
//  - eventos_outlier                         → AdminReposicaoAlertas
//  - views de SLA                            → AdminReposicaoSlaFornecedor
const AdminReposicaoRevisao = lazy(() => import("./AdminReposicaoRevisao"));
const AdminReposicaoHistorico = lazy(() => import("./AdminReposicaoHistorico"));
const AdminReposicaoAlertas = lazy(() => import("./AdminReposicaoAlertas"));
const AdminReposicaoSlaFornecedor = lazy(() => import("./AdminReposicaoSlaFornecedor"));

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

export default function AdminReposicaoParametrosQualidade() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "revisao";

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex items-center gap-3">
        <Settings className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Parâmetros & Qualidade</h1>
          <p className="text-sm text-muted-foreground">
            Revisão, histórico, outliers e SLA dos fornecedores
          </p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
          <TabsTrigger value="revisao">Revisão</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="alertas">Outliers</TabsTrigger>
          <TabsTrigger value="sla">SLA fornecedor</TabsTrigger>
        </TabsList>

        <TabsContent value="revisao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoRevisao />
          </Suspense>
        </TabsContent>

        <TabsContent value="historico" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoHistorico />
          </Suspense>
        </TabsContent>

        <TabsContent value="alertas" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoAlertas />
          </Suspense>
        </TabsContent>

        <TabsContent value="sla" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoSlaFornecedor />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
