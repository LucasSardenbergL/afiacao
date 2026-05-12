import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Settings, Loader2, AlertTriangle, Package, Truck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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

const EMPRESA = "OBEN";

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

/* ─── KPI Cards ─── */
function KpiCards() {
  // (a) SKUs pendentes de aprovação — mesma query de AdminReposicaoRevisao (statusFilter === "pendente")
  const { data: skuPendentes } = useQuery({
    queryKey: ["parametros-qualidade-sku-pendentes"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("sku_parametros")
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("ativo", true)
        .is("aprovado_em", null);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (b) Alertas críticos pendentes — mesma query de AdminReposicaoAlertas (stats.criticos)
  const { data: alertasCriticos } = useQuery({
    queryKey: ["parametros-qualidade-alertas-criticos"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("eventos_outlier")
        .select("*", { count: "exact", head: true })
        .eq("status", "pendente")
        .eq("severidade", "critico");
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (c) Fornecedores violando SLA — mesma view de AdminReposicaoSlaFornecedor (v_fornecedor_sla_compliance)
  const { data: fornViolando } = useQuery({
    queryKey: ["parametros-qualidade-sla-violando"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_fornecedor_sla_compliance")
        .select("violando,critico")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const rows = (data ?? []) as { violando: number; critico: number }[];
      return rows.filter((r) => (r.violando ?? 0) > 0 || (r.critico ?? 0) > 0).length;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const cards = [
    {
      label: "SKUs pendentes de aprovação",
      value: skuPendentes ?? 0,
      icon: Package,
      tone: skuPendentes && skuPendentes > 0 ? "text-warning" : "text-muted-foreground",
      border: skuPendentes && skuPendentes > 0 ? "border-warning/40" : "border-border",
    },
    {
      label: "Alertas críticos pendentes",
      value: alertasCriticos ?? 0,
      icon: AlertTriangle,
      tone: alertasCriticos && alertasCriticos > 0 ? "text-destructive" : "text-muted-foreground",
      border: alertasCriticos && alertasCriticos > 0 ? "border-destructive/40" : "border-border",
    },
    {
      label: "Fornecedores violando SLA",
      value: fornViolando ?? 0,
      icon: Truck,
      tone: fornViolando && fornViolando > 0 ? "text-warning" : "text-muted-foreground",
      border: fornViolando && fornViolando > 0 ? "border-warning/40" : "border-border",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {cards.map((c) => (
        <Card key={c.label} className={c.border}>
          <CardContent className="pt-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className={`text-2xl font-bold mt-1 ${c.tone}`}>{c.value}</div>
            </div>
            <c.icon className={`h-8 w-8 ${c.tone} opacity-60`} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AdminReposicaoParametros() {
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
            Revisão de parâmetros, triagem de outliers, histórico de alterações e compliance de SLA — em um só lugar.
          </p>
        </div>
      </header>

      <KpiCards />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
          <TabsTrigger value="revisao">Revisão</TabsTrigger>
          <TabsTrigger value="alertas">Alertas</TabsTrigger>
          <TabsTrigger value="sla">SLA de Fornecedor</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="revisao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoRevisao />
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

        <TabsContent value="historico" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoHistorico />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
