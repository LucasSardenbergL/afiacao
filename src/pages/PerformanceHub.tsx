import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Loader2,
  Trophy,
  Target,
  Phone,
  MessageSquare,
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

const AdminDesTrimestreAtual = lazy(() => import("./AdminDesTrimestreAtual"));
const FarmerCalls = lazy(() => import("./FarmerCalls"));
const CoachingSPIN = lazy(() => import("./CoachingSPIN"));
const FarmerCopilot = lazy(() => import("./FarmerCopilot"));

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

// Helper para queries em tabelas que podem nao existir nos types
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
    queryKey: ["performance-hub-kpis", empresa],
    queryFn: async () => {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const trimestre = Math.floor(now.getMonth() / 3) + 1;
      const ano = now.getFullYear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = supabase as any;

      const [posicao, meta, ligacoes, spin] = await Promise.all([
        safeQuery(
          async () => {
            const { data } = await client
              .from("v_des_posicao_trimestre_ao_vivo")
              .select("posicao_ao_vivo_otimista")
              .eq("empresa", "OBEN")
              .eq("trimestre", trimestre)
              .eq("ano", ano)
              .limit(1)
              .maybeSingle();
            return Number(data?.posicao_ao_vivo_otimista ?? 0);
          },
          0,
        ),
        safeQuery(
          async () => {
            const { data } = await client
              .from("v_des_posicao_trimestre_ao_vivo")
              .select("meta_pessoal")
              .eq("empresa", "OBEN")
              .eq("trimestre", trimestre)
              .eq("ano", ano)
              .limit(1)
              .maybeSingle();
            return Number(data?.meta_pessoal ?? 0);
          },
          0,
        ),
        safeQuery(
          async () => {
            const { count } = await client
              .from("call_logs")
              .select("id", { count: "exact", head: true })
              .gte("created_at", startOfDay);
            return count ?? 0;
          },
          0,
        ),
        Promise.resolve(0),
      ]);

      return { posicao, meta, ligacoes, spin };
    },
  });

  const brl = (n: number) =>
    n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

  const cards = [
    { label: "Posição ao Vivo", value: brl(Number(data?.posicao ?? 0)), icon: Trophy },
    { label: "Meta Pessoal", value: brl(Number(data?.meta ?? 0)), icon: Target },
    { label: "Ligações Hoje", value: data?.ligacoes ?? 0, icon: Phone },
    { label: "Score SPIN Médio", value: data?.spin ?? 0, icon: MessageSquare },
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

export default function PerformanceHub() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "avaliacao";
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
          <Activity className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Performance</h1>
            <p className="text-sm text-muted-foreground">
              Avaliação DES, ligações, coaching SPIN e copiloto comercial em um só lugar.
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
          <TabsTrigger value="avaliacao">Avaliação</TabsTrigger>
          <TabsTrigger value="ligacoes">Ligações</TabsTrigger>
          <TabsTrigger value="coaching">Coaching SPIN</TabsTrigger>
          <TabsTrigger value="copilot">Copilot</TabsTrigger>
        </TabsList>

        <TabsContent value="avaliacao" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminDesTrimestreAtual />
          </Suspense>
        </TabsContent>
        <TabsContent value="ligacoes" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FarmerCalls />
          </Suspense>
        </TabsContent>
        <TabsContent value="coaching" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <CoachingSPIN />
          </Suspense>
        </TabsContent>
        <TabsContent value="copilot" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <FarmerCopilot />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
