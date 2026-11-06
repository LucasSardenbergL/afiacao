import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDias, hojeSP } from "@/lib/time/sp-day";
import { TrendingUp, Tag, ArrowUpRight, Handshake, Sparkles, Building2 } from "lucide-react";
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
import { KpiContagem } from "@/components/reposicao/KpiContagem";

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

  // Os quatro `queryFn` LANÇAM no erro (plano v7, C9). Antes "Promoções vigentes" fazia
  // `if (error) return 0`, e os outros três devolviam `{ value: 0, unavailable: true }`, que o
  // render imprimia como "0" com uma ressalva embaixo: zero com nota de rodapé. Agora quem separa
  // carregando / falhou / zero medido é o <KpiContagem>, e indisponível vira "—" com o motivo.

  // (a) Oportunidades econômicas ativas hoje
  const oportunidades = useQuery({
    queryKey: ["mercado-oportunidades", empresa],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("v_oportunidade_economica_hoje")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa)
        .gt("dias_ate_limite", 0);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (b) Promoções vigentes
  const promocoes = useQuery({
    queryKey: ["mercado-promocoes-vigentes"],
    queryFn: async () => {
      const today = hojeSP(); // o "hoje" de v_oportunidade_economica_hoje (dia de SP)
      const { count, error } = await supabase
        .from("promocao_campanha")
        .select("*", { count: "exact", head: true })
        .lte("data_inicio", today)
        .gte("data_fim", today)
        .eq("estado", "ativa");
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (c) Aumentos com vigência nos próximos 30 dias
  const aumentos = useQuery({
    queryKey: ["mercado-aumentos-30d"],
    queryFn: async () => {
      const todayISO = hojeSP();
      const in30ISO = addDias(todayISO, 30);
      const { count, error } = await supabase
        .from("fornecedor_aumento_anunciado")
        .select("*", { count: "exact", head: true })
        .gte("data_vigencia", todayISO)
        .lte("data_vigencia", in30ISO);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (d) Sugestões de negociação ativas
  const negociacoes = useQuery({
    queryKey: ["mercado-negociacoes-ativas", empresa],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("v_sugestao_negociacao_ativa")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <KpiContagem
        id="oportunidades-ativas"
        label="Oportunidades ativas hoje"
        icon={Sparkles}
        query={oportunidades}
        tone="text-status-success"
        border="border-status-success/40"
      />
      <KpiContagem
        id="promocoes-vigentes"
        label="Promoções vigentes"
        icon={Tag}
        query={promocoes}
        tone="text-primary"
        border="border-primary/40"
      />
      <KpiContagem
        id="aumentos-30d"
        label="Aumentos próximos 30 dias"
        icon={ArrowUpRight}
        query={aumentos}
        tone="text-status-warning"
        border="border-status-warning/40"
      />
      <KpiContagem
        id="negociacoes-sugeridas"
        label="Negociações sugeridas"
        icon={Handshake}
        query={negociacoes}
        tone="text-primary"
        border="border-primary/40"
      />
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
      <div className="container mx-auto px-4 sm:px-6 pt-4 sm:pt-6 pb-24 max-w-7xl space-y-6">
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
