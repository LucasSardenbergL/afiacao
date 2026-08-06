import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp, Tag, ArrowUpRight, Handshake, Sparkles, Building2 } from "lucide-react";
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
import { ReposicaoEmpresaProvider, useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";

// Reaproveita as 4 telas originais — mesmas queries Supabase, sem duplicar.
//  - v_oportunidade_economica_hoje               → AdminReposicaoOportunidades
//  - promocao_campanha + promocao_item           → AdminReposicaoPromocoes
//  - fornecedor_aumento_anunciado                → AdminReposicaoAumentos
//  - v_sugestao_negociacao_ativa + ranking       → AdminReposicaoNegociacaoParalela
const AdminReposicaoOportunidades = lazy(() => import("./AdminReposicaoOportunidades"));
const AdminReposicaoPromocoes = lazy(() => import("./AdminReposicaoPromocoes"));
const AdminReposicaoAumentos = lazy(() => import("./AdminReposicaoAumentos"));
const AdminReposicaoNegociacaoParalela = lazy(() => import("./AdminReposicaoNegociacaoParalela"));

const TabFallback = () => <PageSkeleton variant="auto" />;

/* ─── KPI Cards ─── */
function KpiCards() {
  const { empresa } = useReposicaoEmpresa();

  // (a) Oportunidades econômicas ativas hoje
  const { data: oportunidades } = useQuery({
    queryKey: ["mercado-oportunidades", empresa],
    queryFn: async () => {
      try {
        const { count, error } = await supabase
          .from("v_oportunidade_economica_hoje")
          .select("*", { count: "exact", head: true })
          .eq("empresa", empresa)
          .gt("dias_ate_limite", 0);
        if (error) return { value: 0, unavailable: true };
        return { value: count ?? 0, unavailable: false };
      } catch {
        return { value: 0, unavailable: true };
      }
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (b) Promoções vigentes
  const { data: promocoes } = useQuery({
    queryKey: ["mercado-promocoes-vigentes"],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { count, error } = await supabase
        .from("promocao_campanha")
        .select("*", { count: "exact", head: true })
        .lte("data_inicio", today)
        .gte("data_fim", today)
        .eq("estado", "ativa");
      if (error) return 0;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (c) Aumentos com vigência nos próximos 30 dias
  const { data: aumentos } = useQuery({
    queryKey: ["mercado-aumentos-30d"],
    queryFn: async () => {
      try {
        const today = new Date();
        const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
        const todayISO = today.toISOString().slice(0, 10);
        const in30ISO = in30.toISOString().slice(0, 10);
        const { count, error } = await supabase
          .from("fornecedor_aumento_anunciado")
          .select("*", { count: "exact", head: true })
          .gte("data_vigencia", todayISO)
          .lte("data_vigencia", in30ISO);
        if (error) return { value: 0, unavailable: true };
        return { value: count ?? 0, unavailable: false };
      } catch {
        return { value: 0, unavailable: true };
      }
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (d) Sugestões de negociação ativas
  const { data: negociacoes } = useQuery({
    queryKey: ["mercado-negociacoes-ativas", empresa],
    queryFn: async () => {
      try {
        const { count, error } = await supabase
          .from("v_sugestao_negociacao_ativa")
          .select("*", { count: "exact", head: true })
          .eq("empresa", empresa);
        if (error) return { value: 0, unavailable: true };
        return { value: count ?? 0, unavailable: false };
      } catch {
        return { value: 0, unavailable: true };
      }
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const oportunidadesValue = oportunidades?.value ?? 0;
  const oportunidadesUnavailable = oportunidades?.unavailable ?? false;
  const aumentosValue = aumentos?.value ?? 0;
  const aumentosUnavailable = aumentos?.unavailable ?? false;
  const negociacoesValue = negociacoes?.value ?? 0;
  const negociacoesUnavailable = negociacoes?.unavailable ?? false;
  const promocoesValue = promocoes ?? 0;

  const cards = [
    {
      label: "Oportunidades ativas hoje",
      value: oportunidadesValue,
      unavailable: oportunidadesUnavailable,
      icon: Sparkles,
      tone: oportunidadesValue > 0 ? "text-success" : "text-muted-foreground",
      border: oportunidadesValue > 0 ? "border-success/40" : "border-border",
    },
    {
      label: "Promoções vigentes",
      value: promocoesValue,
      unavailable: false,
      icon: Tag,
      tone: promocoesValue > 0 ? "text-primary" : "text-muted-foreground",
      border: promocoesValue > 0 ? "border-primary/40" : "border-border",
    },
    {
      label: "Aumentos próximos 30 dias",
      value: aumentosValue,
      unavailable: aumentosUnavailable,
      icon: ArrowUpRight,
      tone: aumentosValue > 0 ? "text-warning" : "text-muted-foreground",
      border: aumentosValue > 0 ? "border-warning/40" : "border-border",
    },
    {
      label: "Negociações sugeridas",
      value: negociacoesValue,
      unavailable: negociacoesUnavailable,
      icon: Handshake,
      tone: negociacoesValue > 0 ? "text-primary" : "text-muted-foreground",
      border: negociacoesValue > 0 ? "border-primary/40" : "border-border",
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
              {c.unavailable && (
                <div className="text-[11px] text-muted-foreground mt-0.5">Sem dados disponíveis</div>
              )}
            </div>
            <c.icon className={`h-8 w-8 ${c.tone} opacity-60`} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AdminReposicaoMercado() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "oportunidades";
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
            <TrendingUp className="h-6 w-6 text-primary" />
            <div>
              <div className="text-[10px] font-semibold tracking-wider text-primary uppercase">Etapa 1</div>
              <h1 className="text-2xl font-bold">Mercado</h1>
              <p className="text-sm text-muted-foreground">
                Oportunidades de compra, promoções ativas, aumentos anunciados e negociações paralelas — em um só lugar.
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
            <TabsTrigger value="oportunidades">Oportunidades</TabsTrigger>
            <TabsTrigger value="promocoes">Promoções</TabsTrigger>
            <TabsTrigger value="aumentos">Aumentos</TabsTrigger>
            <TabsTrigger value="negociacao">Negociação Paralela</TabsTrigger>
          </TabsList>

          <TabsContent value="oportunidades" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoOportunidades />
            </Suspense>
          </TabsContent>

          <TabsContent value="promocoes" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoPromocoes />
            </Suspense>
          </TabsContent>

          <TabsContent value="aumentos" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoAumentos />
            </Suspense>
          </TabsContent>

          <TabsContent value="negociacao" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoNegociacaoParalela />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </ReposicaoEmpresaProvider>
  );
}
