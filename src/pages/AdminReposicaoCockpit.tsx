import { lazy, Suspense, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { format, subDays } from "date-fns";
import { Sparkles, Loader2, CalendarRange } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProcessoComprasStepper } from "@/components/reposicao/ProcessoComprasStepper";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Reaproveita as 3 telas originais como conteúdo das abas — mesmas queries Supabase.
const AdminReposicaoPedidos = lazy(() => import("./AdminReposicaoPedidos"));
const AdminReposicaoOportunidades = lazy(() => import("./AdminReposicaoOportunidades"));
const AdminReposicaoAplicacao = lazy(() => import("./AdminReposicaoAplicacao"));
const AdminReposicaoHistorico = lazy(() => import("./AdminReposicaoHistorico"));

const EMPRESA = "OBEN";

const formatBRL = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

const formatDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

const TabFallback = () => (
  <div className="flex items-center justify-center py-16 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Carregando...
  </div>
);

function CiclosAnterioresTab() {
  const dataFim = useMemo(() => new Date(), []);
  const dataInicio = useMemo(() => subDays(dataFim, 29), [dataFim]);

  type Row = {
    data_ciclo: string;
    fornecedor_nome: string | null;
    valor_total: number | null;
    status: string | null;
  };

  const { data: ciclos = [], isLoading } = useQuery({
    queryKey: ["cockpit-ciclos-anteriores", EMPRESA, format(dataFim, "yyyy-MM-dd")],
    queryFn: async () => {
      const inicio = format(dataInicio, "yyyy-MM-dd");
      const fim = format(dataFim, "yyyy-MM-dd");
      const { data, error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .select("data_ciclo,fornecedor_nome,valor_total,status")
        .eq("empresa", EMPRESA)
        .gte("data_ciclo", inicio)
        .lte("data_ciclo", fim);
      if (error) throw error;
      const rows = ((data ?? []) as unknown) as Row[];
      const map = new Map<
        string,
        { data: string; fornecedores: Set<string>; pedidos: number; valor: number; disparados: number; cancelados: number }
      >();
      for (const r of rows) {
        if (!map.has(r.data_ciclo)) {
          map.set(r.data_ciclo, {
            data: r.data_ciclo,
            fornecedores: new Set(),
            pedidos: 0,
            valor: 0,
            disparados: 0,
            cancelados: 0,
          });
        }
        const acc = map.get(r.data_ciclo)!;
        if (r.fornecedor_nome) acc.fornecedores.add(r.fornecedor_nome);
        acc.pedidos += 1;
        acc.valor += Number(r.valor_total ?? 0);
        if (r.status === "disparado" || r.status === "disparado_simulado") acc.disparados += 1;
        if (r.status === "cancelado") acc.cancelados += 1;
      }
      return Array.from(map.values())
        .map((x) => ({ ...x, fornecedores: x.fornecedores.size }))
        .sort((a, b) => b.data.localeCompare(a.data));
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Últimos 30 dias</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {format(dataInicio, "dd/MM/yyyy")} até {format(dataFim, "dd/MM/yyyy")}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <TabFallback />
        ) : ciclos.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Nenhum ciclo no período.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Fornecedores</TableHead>
                <TableHead className="text-right">Pedidos</TableHead>
                <TableHead className="text-right">Disparados</TableHead>
                <TableHead className="text-right">Cancelados</TableHead>
                <TableHead className="text-right">Valor total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ciclos.map((c) => (
                <TableRow key={c.data}>
                  <TableCell className="text-sm">{formatDate(c.data)}</TableCell>
                  <TableCell className="text-right">{c.fornecedores}</TableCell>
                  <TableCell className="text-right">{c.pedidos}</TableCell>
                  <TableCell className="text-right text-emerald-700 dark:text-emerald-400">
                    {c.disparados}
                  </TableCell>
                  <TableCell className="text-right text-destructive">{c.cancelados}</TableCell>
                  <TableCell className="text-right font-medium">{formatBRL(c.valor)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminReposicaoCockpit() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "ciclo";

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex items-center gap-3">
        <Sparkles className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Cockpit de Reposição</h1>
          <p className="text-sm text-muted-foreground">
            Todo o ciclo diário de compras em uma única tela
          </p>
        </div>
      </header>

      <ProcessoComprasStepper currentStep={3} />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
          <TabsTrigger value="ciclo">Ciclo de hoje</TabsTrigger>
          <TabsTrigger value="oportunidades">Oportunidades</TabsTrigger>
          <TabsTrigger value="aplicar">Aplicar no Omie</TabsTrigger>
          <TabsTrigger value="historico">Ciclos anteriores</TabsTrigger>
        </TabsList>

        <TabsContent value="ciclo" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoPedidos />
          </Suspense>
        </TabsContent>

        <TabsContent value="oportunidades" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoOportunidades />
          </Suspense>
        </TabsContent>

        <TabsContent value="aplicar" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoAplicacao />
          </Suspense>
        </TabsContent>

        <TabsContent value="historico" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoHistorico />
          </Suspense>
        </TabsContent>

      </Tabs>
    </div>
  );
}
