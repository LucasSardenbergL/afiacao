import { lazy, Suspense, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Wrench,
  FileText,
  Package,
  Network,
  Printer,
  Building2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { STATUS_NAO_VENDA_POSTGREST } from "@/lib/farmer/universo-pedidos";
import { janelaQueryDiaCivil, pedidoNoDiaCivil } from "@/lib/pedido/dia-civil";
import { fetchAllPages } from "@/lib/postgrest";

const SalesQuotes = lazy(() => import("./SalesQuotes"));
const SalesPrint = lazy(() => import("./SalesPrintDashboard"));
const FarmerRecommendations = lazy(() => import("./FarmerRecommendations"));
const FarmerBundles = lazy(() => import("./FarmerBundles"));

const TabFallback = () => <PageSkeleton variant="auto" />;

function KpiCards({ empresa }: { empresa: string }) {
  void empresa;

  // Antes os 4 cards contavam `sales_quotes`, `farmer_bundles`, `farmer_bundle_rules` e
  // `sales_print_jobs` por um cliente com cast duplo para `{ from: (t: string) => any }`. NENHUMA dessas
  // tabelas existe na prod (conferido em 2026-10-20): o erro era engolido e o card mostrava 0 para
  // sempre. Regra agora: cada card conta a MESMA fonte da aba que ele resume, logo abaixo. Falha de
  // leitura deixa o card em "—" (a query lança; ausente ≠ zero).
  const { data: orcamentos } = useQuery({
    queryKey: ["vendas-ferramentas-kpis", "orcamentos"],
    queryFn: async (): Promise<number | null> => {
      const { count, error } = await supabase
        .from("sales_orders")
        .select("id", { count: "exact", head: true })
        .eq("status", "orcamento")
        .is("deleted_at", null);
      if (error) throw error;
      return count;
    },
  });

  // Aba Bundles: a geração VIGENTE é a `pendente` (as anteriores viram `expirado` na substituição).
  const { data: bundlesAtivos } = useQuery({
    queryKey: ["vendas-ferramentas-kpis", "bundles-ativos"],
    queryFn: async (): Promise<number | null> => {
      const { count, error } = await supabase
        .from("farmer_bundle_recommendations")
        .select("id", { count: "exact", head: true })
        .eq("status", "pendente");
      if (error) throw error;
      return count;
    },
  });

  // Aba Bundles: as regras de associação que o motor usa (tabela global).
  const { data: regras } = useQuery({
    queryKey: ["vendas-ferramentas-kpis", "regras-associacao"],
    queryFn: async (): Promise<number | null> => {
      const { count, error } = await supabase
        .from("farmer_association_rules")
        .select("id", { count: "exact", head: true });
      if (error) throw error;
      return count;
    },
  });

  // Aba Impressão: o app não registra impressão (não há `sales_print_jobs`), então o card conta o
  // que a aba LISTA para hoje — vendas do universo canônico + afiação não cancelada, na mesma
  // janela e com o mesmo `pedidoNoDiaCivil` do SalesPrintDashboard.
  const { data: pedidosHoje } = useQuery({
    queryKey: ["vendas-ferramentas-kpis", "pedidos-hoje", new Date().toDateString()],
    queryFn: async (): Promise<number> => {
      const hoje = new Date();
      const { inicioIso, fimIso } = janelaQueryDiaCivil(hoje);
      const [vendas, afiacao] = await Promise.all([
        fetchAllPages(
          (de, ate) =>
            supabase
              .from("sales_orders")
              .select("id, created_at")
              .gte("created_at", inicioIso)
              .lte("created_at", fimIso)
              .not("status", "in", STATUS_NAO_VENDA_POSTGREST)
              .is("deleted_at", null)
              .order("id", { ascending: true })
              .range(de, ate),
          "sales_orders (kpi pedidos de hoje)",
        ),
        fetchAllPages(
          (de, ate) =>
            supabase
              .from("orders")
              .select("id, created_at")
              .gte("created_at", inicioIso)
              .lte("created_at", fimIso)
              .neq("status", "cancelado")
              .order("id", { ascending: true })
              .range(de, ate),
          "orders (kpi pedidos de hoje)",
        ),
      ]);
      return [...vendas, ...afiacao].filter((p) => pedidoNoDiaCivil(p.created_at, hoje)).length;
    },
  });

  const cards = [
    { label: "Orçamentos Salvos", value: orcamentos ?? "—", icon: FileText },
    { label: "Bundles Ativos", value: bundlesAtivos ?? "—", icon: Package },
    { label: "Regras de Associação", value: regras ?? "—", icon: Network },
    { label: "Pedidos p/ Imprimir Hoje", value: pedidosHoje ?? "—", icon: Printer },
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

export default function VendasFerramentas() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "orcamentos";
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
          <Wrench className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Ferramentas de Venda</h1>
            <p className="text-sm text-muted-foreground">
              Orçamentos, impressão em lote, recomendações e bundles para acelerar a venda.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/cobranca" data-testid="vendas-link-cobranca">Cobranças da minha carteira</Link>
          </Button>
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
        <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
          <TabsTrigger value="orcamentos">Orçamentos</TabsTrigger>
          <TabsTrigger value="impressao">Impressão</TabsTrigger>
          <TabsTrigger value="recomendacoes">Recomendações</TabsTrigger>
          <TabsTrigger value="bundles">Bundles</TabsTrigger>
        </TabsList>

        <TabsContent value="orcamentos" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <SalesQuotes />
          </Suspense>
        </TabsContent>
        <TabsContent value="impressao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <SalesPrint />
          </Suspense>
        </TabsContent>
        <TabsContent value="recomendacoes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FarmerRecommendations />
          </Suspense>
        </TabsContent>
        <TabsContent value="bundles" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FarmerBundles />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
