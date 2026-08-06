import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BarChart3,
  Tags,
  ArrowLeftRight,
  Receipt,
  RefreshCw,
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

const FinanceiroAnalytics = lazy(() => import("./FinanceiroAnalytics"));
const FinanceiroIntercompany = lazy(() => import("./FinanceiroIntercompany"));
const FinanceiroTributario = lazy(() => import("./FinanceiroTributario"));
const FinanceiroMapping = lazy(() => import("./FinanceiroMapping"));
const FinanceiroSync = lazy(() => import("./FinanceiroSync"));

const TabFallback = () => <PageSkeleton variant="auto" />;

function KpiCards({ empresa }: { empresa: string }) {
  // TODO: buscar contagens reais do Supabase filtradas por empresa={empresa}
  void empresa;
  const cards = [
    {
      label: "Lançamentos sem categoria",
      value: 0,
      icon: Tags,
      tone: "text-muted-foreground",
    },
    {
      label: "Transferências pendentes",
      value: 0,
      icon: ArrowLeftRight,
      tone: "text-muted-foreground",
    },
    {
      label: "Impostos a vencer",
      value: 0,
      icon: Receipt,
      tone: "text-muted-foreground",
    },
    {
      label: "Última sincronização",
      value: "—",
      icon: RefreshCw,
      tone: "text-muted-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <Card key={c.label} className="border-border">
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

export default function FinanceiroAnalise() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "exploracao";
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
          <BarChart3 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Análise e Config Financeira</h1>
            <p className="text-sm text-muted-foreground">
              Exploração, intercompany, tributário, mapeamento DRE e sincronização.
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
          <TabsTrigger value="exploracao">Exploração</TabsTrigger>
          <TabsTrigger value="intercompany">Intercompany</TabsTrigger>
          <TabsTrigger value="tributario">Tributário</TabsTrigger>
          <TabsTrigger value="mapeamento">Mapeamento DRE</TabsTrigger>
          <TabsTrigger value="sync">Sincronização</TabsTrigger>
        </TabsList>

        <TabsContent value="exploracao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroAnalytics />
          </Suspense>
        </TabsContent>
        <TabsContent value="intercompany" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroIntercompany />
          </Suspense>
        </TabsContent>
        <TabsContent value="tributario" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroTributario />
          </Suspense>
        </TabsContent>
        <TabsContent value="mapeamento" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroMapping />
          </Suspense>
        </TabsContent>
        <TabsContent value="sync" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroSync />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
