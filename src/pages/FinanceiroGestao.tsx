import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { somarSaldoAberto } from "@/services/financeiroService";
import type { Company } from "@/contexts/CompanyContext";
import {
  Wallet,
  TrendingDown,
  TrendingUp,
  Banknote,
  AlertTriangle,
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

const FinanceiroDashboard = lazy(() => import("./FinanceiroDashboard"));
const FinanceiroCapitalGiro = lazy(() => import("./FinanceiroCapitalGiro"));
const FinanceiroConciliacao = lazy(() => import("./FinanceiroConciliacao"));
const FinanceiroOrcamento = lazy(() => import("./FinanceiroOrcamento"));
const FinanceiroFechamento = lazy(() => import("./FinanceiroFechamento"));

const TabFallback = () => <PageSkeleton variant="auto" />;

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function KpiCards({ empresa }: { empresa: string }) {
  // O Select acima só produz "OBEN"/"COLACOR" → lowercase casa o Company do service.
  const company = empresa.toLowerCase() as Company;

  // Σ saldo dos títulos EM ABERTO via somarSaldoAberto — a mesma fonte do DSO:
  // OPEN_TITLE_STATUSES (vocabulário nativo do Omie) + paginação do cap de
  // 1000 + throw em erro. A versão anterior fazia .neq('status_titulo','PAGO')
  // — que INCLUÍA RECEBIDO/LIQUIDADO (saldo cheio por causa do #396, com
  // fallback pro valor_documento) e até CANCELADO — e sem .limit() truncava a
  // soma nas 1000 primeiras linhas (a oben tem ~12k títulos de CR): o número
  // exibido era errado nos dois sentidos.
  const { data: receber } = useQuery({
    queryKey: ["fin-gestao-receber", company],
    queryFn: () => somarSaldoAberto("fin_contas_receber", company),
    // Posição de carteira (não muda por minuto) e a query pagina ~12 requests
    // na oben — 5min em vez do 60s da versão truncada.
    refetchInterval: 300_000,
    staleTime: 240_000,
  });

  const { data: pagar } = useQuery({
    queryKey: ["fin-gestao-pagar", company],
    queryFn: () => somarSaldoAberto("fin_contas_pagar", company),
    refetchInterval: 300_000,
    staleTime: 240_000,
  });

  // TODO: tabela fin_saldo_bancario ainda não existe — exibir 0 até ser criada.
  const saldoBancario = 0;

  const { data: inadimplencia } = useQuery({
    queryKey: ["fin-gestao-inadimp", company],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_aging_receber")
        .select("*")
        .eq("company", company)
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
    // Alinhado aos KPIs de CR/CP: posição, não tempo-real.
    refetchInterval: 300_000,
    staleTime: 240_000,
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
            <h1
              className="font-display"
              style={{ fontSize: "2rem", fontWeight: 500, letterSpacing: "-0.04em", lineHeight: 1.1 }}
            >
              Gestão Financeira
            </h1>
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
            <FinanceiroDashboard embedded />
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
