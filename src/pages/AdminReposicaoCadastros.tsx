import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Database, Loader2, ShoppingCart, Network, Layers, Send, Building2, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReposicaoEmpresaProvider, useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";

// Reaproveita as 4 telas originais — mesmas queries Supabase, sem duplicar.
//  - pedido_compra_sugerido + pedido_compra_item     → AdminReposicaoPedidos
//  - fornecedor_grupo_producao + sku_grupo_producao  → AdminReposicaoCadeiaLogistica / GruposProducao
//  - fila_aplicacao_omie                             → AdminReposicaoAplicacao
const AdminReposicaoPedidos = lazy(() => import("./AdminReposicaoPedidos"));
const AdminReposicaoCadeiaLogistica = lazy(() => import("./AdminReposicaoCadeiaLogistica"));
const AdminReposicaoGruposProducao = lazy(() => import("./AdminReposicaoGruposProducao"));
const AdminReposicaoAplicacao = lazy(() => import("./AdminReposicaoAplicacao"));

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

/* ─── KPI Cards ─── */
function KpiCards() {
  const { empresa } = useReposicaoEmpresa();

  // (a) Pedidos de compra abertos (sugeridos/em edição)
  const { data: pedidosAbertos } = useQuery({
    queryKey: ["cadastros-pedidos-abertos", empresa],
    queryFn: async () => {
      const { count, error } = await (supabase as any)
        .from("pedido_compra_sugerido")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa)
        .in("status", ["sugerido", "em_edicao", "rascunho"]);
      if (error) return 0;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (b) SKUs sem cadeia logística mapeada — sku_parametros ativos sem grupo de produção
  const { data: skusSemCadeia } = useQuery({
    queryKey: ["cadastros-skus-sem-cadeia", empresa],
    queryFn: async () => {
      const { data: comGrupo, error: e1 } = await (supabase as any)
        .from("sku_grupo_producao")
        .select("sku_codigo");
      if (e1) return 0;
      const setComGrupo = new Set((comGrupo ?? []).map((r: any) => r.sku_codigo));

      const { data: ativos, error: e2 } = await supabase
        .from("sku_parametros")
        .select("sku_codigo")
        .eq("empresa", empresa)
        .eq("ativo", true);
      if (e2) return 0;

      return (ativos ?? []).filter((r: any) => !setComGrupo.has(r.sku_codigo)).length;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (c) Fila de aplicação Omie pendente
  const { data: filaPendente } = useQuery({
    queryKey: ["cadastros-fila-pendente", empresa],
    queryFn: async () => {
      const { count, error } = await (supabase as any)
        .from("fila_aplicacao_omie")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa)
        .eq("status", "pendente");
      if (error) return 0;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const cards = [
    {
      label: "Pedidos de compra abertos",
      value: pedidosAbertos ?? 0,
      icon: ShoppingCart,
      tone: pedidosAbertos && pedidosAbertos > 0 ? "text-primary" : "text-muted-foreground",
      border: pedidosAbertos && pedidosAbertos > 0 ? "border-primary/40" : "border-border",
    },
    {
      label: "SKUs sem cadeia logística",
      value: skusSemCadeia ?? 0,
      icon: AlertTriangle,
      tone: skusSemCadeia && skusSemCadeia > 0 ? "text-warning" : "text-muted-foreground",
      border: skusSemCadeia && skusSemCadeia > 0 ? "border-warning/40" : "border-border",
    },
    {
      label: "Fila de aplicação Omie",
      value: filaPendente ?? 0,
      icon: Send,
      tone: filaPendente && filaPendente > 0 ? "text-primary" : "text-muted-foreground",
      border: filaPendente && filaPendente > 0 ? "border-primary/40" : "border-border",
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

export default function AdminReposicaoCadastros() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "pedidos";
  const [empresa, setEmpresa] = useState("OBEN");

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <ReposicaoEmpresaProvider value={{ empresa, setEmpresa }}>
      <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
        <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <Database className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Cadastros & Config</h1>
              <p className="text-sm text-muted-foreground">
                Grupos de produção, cadeia logística, mapeamento de SKUs e pedidos sugeridos.
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

        <KpiCards />

        <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
          <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
            <TabsTrigger value="pedidos">
              <ShoppingCart className="h-4 w-4 mr-1" /> Pedidos
            </TabsTrigger>
            <TabsTrigger value="cadeia">
              <Network className="h-4 w-4 mr-1" /> Cadeia Logística
            </TabsTrigger>
            <TabsTrigger value="grupos">
              <Layers className="h-4 w-4 mr-1" /> Grupos
            </TabsTrigger>
            <TabsTrigger value="aplicacao">
              <Send className="h-4 w-4 mr-1" /> Aplicação Omie
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pedidos" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoPedidos />
            </Suspense>
          </TabsContent>

          <TabsContent value="cadeia" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoCadeiaLogistica />
            </Suspense>
          </TabsContent>

          <TabsContent value="grupos" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoGruposProducao />
            </Suspense>
          </TabsContent>

          <TabsContent value="aplicacao" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoAplicacao />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </ReposicaoEmpresaProvider>
  );
}
