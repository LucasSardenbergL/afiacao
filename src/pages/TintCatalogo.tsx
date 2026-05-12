import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Palette,
  Loader2,
  FlaskConical,
  Package,
  Droplet,
  Clock,
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

const TintFormulas = lazy(() => import("./TintFormulas"));
const TintCorantes = lazy(() => import("./TintCorantes"));
const TintMapping = lazy(() => import("./TintMapping"));
const TintPricing = lazy(() => import("./TintPricing"));

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

function KpiCards({ empresa }: { empresa: string }) {
  void empresa;

  const { data } = useQuery({
    queryKey: ["tint-catalogo-kpis", empresa],
    queryFn: async () => {
      const [formulas, skusTotal, skusMapeados, corantes] = await Promise.all([
        supabase.from("tint_formulas").select("id", { count: "exact", head: true }).eq("account", "oben"),
        supabase.from("tint_skus").select("id", { count: "exact", head: true }).eq("account", "oben"),
        supabase
          .from("tint_skus")
          .select("id", { count: "exact", head: true })
          .eq("account", "oben")
          .not("omie_product_id", "is", null),
        supabase.from("tint_corantes").select("id", { count: "exact", head: true }).eq("account", "oben"),
      ]);
      // TODO: tabela tint_import_runs nao existe ainda; usando "—"
      return {
        formulas: formulas.count ?? 0,
        skusTotal: skusTotal.count ?? 0,
        skusMapeados: skusMapeados.count ?? 0,
        corantes: corantes.count ?? 0,
        ultimaImport: "—",
      };
    },
  });

  const cards = [
    {
      label: "Fórmulas Importadas",
      value: data?.formulas ?? 0,
      icon: FlaskConical,
    },
    {
      label: "SKUs Mapeados",
      value:
        data === undefined
          ? 0
          : `${data.skusMapeados}/${data.skusTotal}`,
      icon: Package,
    },
    {
      label: "Corantes",
      value: data?.corantes ?? 0,
      icon: Droplet,
    },
    {
      label: "Última Importação",
      value: data?.ultimaImport ?? "—",
      icon: Clock,
    },
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

export default function TintCatalogo() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "formulas";
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
          <Palette className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Catálogo e Preços</h1>
            <p className="text-sm text-muted-foreground">
              Fórmulas, corantes, mapeamento de SKUs e precificação tintométrica.
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
          <TabsTrigger value="formulas">Fórmulas</TabsTrigger>
          <TabsTrigger value="corantes">Corantes</TabsTrigger>
          <TabsTrigger value="mapeamento">Mapeamento</TabsTrigger>
          <TabsTrigger value="precificacao">Precificação</TabsTrigger>
        </TabsList>

        <TabsContent value="formulas" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintFormulas />
          </Suspense>
        </TabsContent>
        <TabsContent value="corantes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintCorantes />
          </Suspense>
        </TabsContent>
        <TabsContent value="mapeamento" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintMapping />
          </Suspense>
        </TabsContent>
        <TabsContent value="precificacao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <TintPricing />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
