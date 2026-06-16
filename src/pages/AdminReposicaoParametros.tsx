import { lazy, Suspense, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Settings, Loader2, AlertTriangle, Truck, Building2, Sparkles, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReposicaoEmpresaProvider, useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
// Reaproveita as telas originais — mesmas queries Supabase, sem duplicar.
// A aprovação manual de parâmetros foi APOSENTADA: os parâmetros são aplicados
// automaticamente todo dia (resumo + reverter em /admin/reposicao/mudancas-automaticas).
// A aba "Ajuste manual" mantém só o editor por SKU (mínimo de compra forçado, editar
// valores na mão, promover candidato de 1ª compra) — sem teatro de aprovação.
// Tabelas/views usadas:
//  - sku_parametros + views                  → AdminReposicaoRevisao (ajuste manual)
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

/* ─── KPI Cards ─── */
function KpiCards() {
  const { empresa } = useReposicaoEmpresa();

  // (b) Alertas críticos pendentes — mesma query de AdminReposicaoAlertas (stats.criticos)
  const { data: alertasCriticos } = useQuery({
    queryKey: ["parametros-alertas-criticos"],
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
    queryKey: ["parametros-sla-violando", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_fornecedor_sla_compliance")
        .select("skus_violando,skus_criticos")
        .eq("empresa", empresa);
      if (error) throw error;
      const rows = (data ?? []) as { skus_violando: number | null; skus_criticos: number | null }[];
      return rows.filter((r) => (r.skus_violando ?? 0) > 0 || (r.skus_criticos ?? 0) > 0).length;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const cards = [
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
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

const VALID_TABS = ["ajuste", "alertas", "sla", "historico"];

export default function AdminReposicaoParametros() {
  const [params, setParams] = useSearchParams();
  // "revisao" (legado) cai em "ajuste"; qualquer tab inválida idem.
  const rawTab = params.get("tab") === "revisao" ? "ajuste" : (params.get("tab") ?? "ajuste");
  const tab = VALID_TABS.includes(rawTab) ? rawTab : "ajuste";
  const [empresa, setEmpresa] = useState("OBEN");

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <ReposicaoEmpresaProvider value={{ empresa, setEmpresa }}>
      <div className="space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <Settings className="h-6 w-6 text-primary" />
            <div>
              <div className="text-[10px] font-semibold tracking-wider text-primary uppercase">Etapa 2</div>
              <h1 className="text-2xl font-bold">Parâmetros</h1>
              <p className="text-sm text-muted-foreground">
                Triagem de outliers, histórico de alterações e compliance de SLA. Os parâmetros são ajustados automaticamente.
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

        {/* Parâmetros geridos automaticamente — substitui a antiga aba "Revisão" (aprovação manual). */}
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <Sparkles className="h-5 w-5 text-primary mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold">Parâmetros geridos automaticamente</div>
                <p className="text-sm text-muted-foreground">
                  O sistema ajusta ponto de pedido, mínimo e máximo todo dia. Você não precisa aprovar nada —
                  confira o que mudou e reverta se quiser.
                </p>
              </div>
            </div>
            <Button asChild className="shrink-0">
              <Link to="/admin/reposicao/mudancas-automaticas">
                Ver mudanças automáticas
                <ArrowRight className="h-4 w-4 ml-1.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <KpiCards />

        <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
          <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
            <TabsTrigger value="ajuste">Ajuste manual</TabsTrigger>
            <TabsTrigger value="alertas">Alertas</TabsTrigger>
            <TabsTrigger value="sla">SLA de Fornecedor</TabsTrigger>
            <TabsTrigger value="historico">Histórico</TabsTrigger>
          </TabsList>

          <TabsContent value="ajuste" className="m-0">
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
    </ReposicaoEmpresaProvider>
  );
}
