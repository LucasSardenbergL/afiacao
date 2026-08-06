import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { spDayRangeUtc } from "@/lib/time/sp-day";
import {
  PackageCheck,
  FileWarning,
  Truck,
  CheckCircle2,
  Inbox,
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

const Recebimento = lazy(() => import("./Recebimento"));
const NfeReceipt = lazy(() => import("./NfeReceipt"));

const WAREHOUSE_BY_EMPRESA: Record<string, string> = {
  OBEN: "850960ad-b527-43d7-ba3c-f4f20f9412d2",
  COLACOR: "b6d3569b-5952-4547-a118-4ddfe0a85ba3",
};

const TabFallback = () => <PageSkeleton variant="auto" />;

function KpiCards({ empresa }: { empresa: string }) {
  const warehouseId = WAREHOUSE_BY_EMPRESA[empresa];

  const { data: pendentes } = useQuery({
    queryKey: ["estoque-receb-pendentes", warehouseId],
    queryFn: async () => {
      const { count } = await supabase
        .from("nfe_recebimentos")
        .select("*", { count: "exact", head: true })
        .eq("warehouse_id", warehouseId)
        .in("status", ["pendente", "em_conferencia"]);
      return count ?? 0;
    },
    refetchInterval: 60000,
  });

  const { data: divergencias } = useQuery({
    queryKey: ["estoque-receb-divergencias", warehouseId],
    queryFn: async () => {
      const { count } = await supabase
        .from("nfe_recebimentos")
        .select("*", { count: "exact", head: true })
        .eq("warehouse_id", warehouseId)
        .eq("status", "divergencia");
      return count ?? 0;
    },
    refetchInterval: 60000,
  });

  const { data: valorTransito } = useQuery({
    queryKey: ["estoque-receb-valor-transito", warehouseId],
    queryFn: async () => {
      const { data } = await supabase
        .from("nfe_recebimentos")
        .select("valor_total")
        .eq("warehouse_id", warehouseId)
        .in("status", ["pendente", "em_conferencia", "divergencia"]);
      return (data ?? []).reduce(
        (acc: number, r: { valor_total: number | null }) => acc + Number(r.valor_total ?? 0),
        0,
      );
    },
    refetchInterval: 60000,
  });

  const { data: efetivadasHoje } = useQuery({
    queryKey: ["estoque-receb-efetivadas-hoje", warehouseId],
    queryFn: async () => {
      // Por efetivado_at (momento da efetivação), não data_emissao (data da nota no fornecedor).
      // Janela [início, fim) do dia em America/Sao_Paulo (recalculada a cada refetch → robusta à virada de dia).
      const { startUtc, endUtc } = spDayRangeUtc();
      const { count } = await supabase
        .from("nfe_recebimentos")
        .select("*", { count: "exact", head: true })
        .eq("warehouse_id", warehouseId)
        .eq("status", "efetivado")
        .gte("efetivado_at", startUtc)
        .lt("efetivado_at", endUtc);
      return count ?? 0;
    },
    refetchInterval: 60000,
  });

  const fmtBRL = (v: number) =>
    v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const cards = [
    {
      label: "NF-es Pendentes",
      value: pendentes ?? 0,
      icon: Inbox,
      tone: (pendentes ?? 0) > 0 ? "text-warning" : "text-muted-foreground",
      border: (pendentes ?? 0) > 0 ? "border-warning/40" : "border-border",
    },
    {
      label: "Divergências",
      value: divergencias ?? 0,
      icon: FileWarning,
      tone: (divergencias ?? 0) > 0 ? "text-destructive" : "text-muted-foreground",
      border: (divergencias ?? 0) > 0 ? "border-destructive/40" : "border-border",
    },
    {
      label: "Valor em Trânsito",
      value: fmtBRL(Number(valorTransito ?? 0)),
      icon: Truck,
      tone: "text-primary",
      border: "border-border",
    },
    {
      label: "Efetivadas Hoje",
      value: efetivadasHoje ?? 0,
      icon: CheckCircle2,
      tone: (efetivadasHoje ?? 0) > 0 ? "text-success" : "text-muted-foreground",
      border: (efetivadasHoje ?? 0) > 0 ? "border-success/40" : "border-border",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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

export default function AdminEstoqueRecebimento() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "nfes";
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
          <PackageCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Recebimento de NF-e</h1>
            <p className="text-sm text-muted-foreground">
              Conferência, histórico e processamento de notas fiscais de entrada.
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
          <TabsTrigger value="nfes">NF-es</TabsTrigger>
          <TabsTrigger value="conferencia">Em Conferência</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="manual">Manual</TabsTrigger>
        </TabsList>

        <TabsContent value="nfes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            {/* falha_efetivacao/efetivacao_parcial entram aqui (NFs que precisam de ação) — A1 as produz */}
            <Recebimento statusFilter={['pendente', 'divergencia', 'falha_efetivacao', 'efetivacao_parcial']} />
          </Suspense>
        </TabsContent>

        <TabsContent value="conferencia" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <Recebimento key="conferencia" statusFilter={['em_conferencia']} />
          </Suspense>
        </TabsContent>

        <TabsContent value="historico" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <Recebimento key="historico" statusFilter={['efetivado', 'conferido']} />
          </Suspense>
        </TabsContent>

        <TabsContent value="manual" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <NfeReceipt />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
