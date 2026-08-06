import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
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

const SalesQuotes = lazy(() => import("./SalesQuotes"));
const SalesPrint = lazy(() => import("./SalesPrintDashboard"));
const FarmerRecommendations = lazy(() => import("./FarmerRecommendations"));
const FarmerBundles = lazy(() => import("./FarmerBundles"));

const TabFallback = () => <PageSkeleton variant="auto" />;

const safeQuery = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

function KpiCards({ empresa }: { empresa: string }) {
  void empresa;

  const { data } = useQuery({
    queryKey: ["vendas-ferramentas-kpis", empresa],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      // tabelas sales_quotes/farmer_bundles/farmer_bundle_rules/sales_print_jobs ainda não estão em Database
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = supabase as unknown as { from: (t: string) => any };

      const countOf = (table: string) =>
        safeQuery(async () => {
          const { count } = await client
            .from(table)
            .select("id", { count: "exact", head: true });
          return count ?? 0;
        }, 0);

      const [orcamentos, bundles, regras, impressoes] = await Promise.all([
        countOf("sales_quotes"),
        countOf("farmer_bundles"),
        countOf("farmer_bundle_rules"),
        safeQuery(async () => {
          const { count } = await client
            .from("sales_print_jobs")
            .select("id", { count: "exact", head: true })
            .gte("data", today);
          return count ?? 0;
        }, 0),
      ]);

      return { orcamentos, bundles, regras, impressoes };
    },
  });

  const cards = [
    { label: "Orçamentos Salvos", value: data?.orcamentos ?? 0, icon: FileText },
    { label: "Bundles Ativos", value: data?.bundles ?? 0, icon: Package },
    { label: "Regras de Associação", value: data?.regras ?? 0, icon: Network },
    { label: "Impressões Hoje", value: data?.impressoes ?? 0, icon: Printer },
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
