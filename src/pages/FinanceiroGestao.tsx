import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Wallet,
  Loader2,
  TrendingDown,
  TrendingUp,
  Banknote,
  AlertTriangle,
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

const FinanceiroDashboard = lazy(() => import("./FinanceiroDashboard"));
const FinanceiroCapitalGiro = lazy(() => import("./FinanceiroCapitalGiro"));
const FinanceiroConciliacao = lazy(() => import("./FinanceiroConciliacao"));
const FinanceiroOrcamento = lazy(() => import("./FinanceiroOrcamento"));
const FinanceiroFechamento = lazy(() => import("./FinanceiroFechamento"));

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function KpiCards({ empresa }: { empresa: string }) {
  const { data: receber } = useQuery({
    queryKey: ["fin-gestao-receber", empresa],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_contas_receber")
        .select("saldo, valor_documento, status_titulo")
        .eq("company", empresa.toLowerCase())
        .neq("status_titulo", "PAGO");
      return (data ?? []).reduce(
        (acc: number, r: { saldo: number | null; valor_documento: number | null }) =>
          acc + Number(r.saldo ?? r.valor_documento ?? 0),
        0,
      );
    },
    refetchInterval: 60000,
  });

  const { data: pagar } = useQuery({
    queryKey: ["fin-gestao-pagar", empresa],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_contas_pagar")
        .select("saldo, valor_documento, status_titulo")
        .eq("company", empresa.toLowerCase())
        .neq("status_titulo", "PAGO");
      return (data ?? []).reduce(
        (acc: number, r: { saldo: number | null; valor_documento: number | null }) =>
          acc + Number(r.saldo ?? r.valor_documento ?? 0),
        0,
      );
    },
    refetchInterval: 60000,
  });

  // TODO: tabela fin_saldo_bancario ainda não existe — exibir 0 até ser criada.
  const saldoBancario = 0;

  const { data: inadimplencia } = useQuery({
    queryKey: ["fin-gestao-inadimp", empresa],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_aging_receber")
        .select("*")
        .eq("company", empresa.toLowerCase())
        .maybeSingle();
      if (!data) return 0;
      const vencido =
        Number(data.vencido_1_30_valor ?? 0) +
        Number(data.vencido_31_60_valor ?? 0) +
        Number(data.vencido_61_90_valor ?? 0) +
        Number(data.vencido_90_plus_valor ?? 0);
      const total = vencido + Number(data.a_vencer_valor ?? 0);
      return total > 0 ? (vencido / total) * 100 : 0;
    },
    refetchInterval: 60000,
  });

  const cards = [
    {
      label: "Total a Receber",
      value: fmtBRL(Number(receber ?? 0)),
      icon: TrendingUp,
      tone: "text-success",
      border: "border-border",
    },
    {
      label: "Total a Pagar",
      value: fmtBRL(Number(pagar ?? 0)),
      icon: TrendingDown,
      tone: "text-destructive",
      border: "border-border",
    },
    {
      label: "Saldo Bancário",
      value: fmtBRL(saldoBancario),
      icon: Banknote,
      tone: "text-muted-foreground",
      border: "border-border",
    },
    {
      label: "Inadimplência %",
      value: `${(Number(inadimplencia ?? 0)).toFixed(1)}%`,
      icon: AlertTriangle,
      tone:
        Number(inadimplencia ?? 0) > 5
          ? "text-destructive"
          : "text-muted-foreground",
      border:
        Number(inadimplencia ?? 0) > 5 ? "border-destructive/40" : "border-border",
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

export default function FinanceiroGestao() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "painel";
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
          <Wallet className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Gestão Financeira</h1>
            <p className="text-sm text-muted-foreground">
              Painel, capital de giro, conciliação, orçamento e fechamento.
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
          <TabsTrigger value="painel">Painel</TabsTrigger>
          <TabsTrigger value="capital">Capital de Giro</TabsTrigger>
          <TabsTrigger value="conciliacao">Conciliação</TabsTrigger>
          <TabsTrigger value="orcamento">Orçamento</TabsTrigger>
          <TabsTrigger value="fechamento">Fechamento</TabsTrigger>
        </TabsList>

        <TabsContent value="painel" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroDashboard />
          </Suspense>
        </TabsContent>
        <TabsContent value="capital" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroCapitalGiro />
          </Suspense>
        </TabsContent>
        <TabsContent value="conciliacao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroConciliacao />
          </Suspense>
        </TabsContent>
        <TabsContent value="orcamento" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroOrcamento />
          </Suspense>
        </TabsContent>
        <TabsContent value="fechamento" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FinanceiroFechamento />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
