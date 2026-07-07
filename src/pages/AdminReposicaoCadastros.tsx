import { lazy, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Database, ShoppingCart, Network, Layers, Send, Building2, AlertTriangle, Link2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReposicaoEmpresaProvider, useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";

// Reaproveita as telas originais para tabs auxiliares — mesmas queries Supabase.
const AdminReposicaoCadeiaLogistica = lazy(() => import("./AdminReposicaoCadeiaLogistica"));
const AdminReposicaoGruposProducao = lazy(() => import("./AdminReposicaoGruposProducao"));
const AdminReposicaoAplicacao = lazy(() => import("./AdminReposicaoAplicacao"));
const AdminSkuMapeamento = lazy(() => import("./AdminSkuMapeamento"));

const TabFallback = () => <PageSkeleton variant="auto" />;

/* ─── KPI Cards ─── */
function KpiCards() {
  const { empresa } = useReposicaoEmpresa();

  // (a) Pedidos de compra abertos (sugeridos/em edição)
  const { data: pedidosAbertos } = useQuery({
    queryKey: ["cadastros-pedidos-abertos", empresa],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("pedido_compra_sugerido")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa)
        .in("status", ["sugerido", "em_edicao", "rascunho"]);
      if (error) return 0;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (b) SKUs sem cadeia logística mapeada — sku_parametros ativos sem grupo de produção
  const { data: skusSemCadeia } = useQuery({
    queryKey: ["cadastros-skus-sem-cadeia", empresa],
    queryFn: async () => {
      const { data: comGrupo, error: e1 } = await supabase
        .from("sku_grupo_producao")
        .select("sku_codigo_omie")
        .eq("empresa", empresa);
      if (e1) return 0;
      const grupoRows = (comGrupo ?? []) as unknown as Array<{ sku_codigo_omie: string | number | null }>;
      const setComGrupo = new Set(grupoRows.map((r) => String(r.sku_codigo_omie)));

      const { data: ativos, error: e2 } = await supabase
        .from("sku_parametros")
        .select("sku_codigo_omie")
        .eq("empresa", empresa)
        .eq("ativo", true);
      if (e2) return 0;

      const ativosRows = (ativos ?? []) as unknown as Array<{ sku_codigo_omie: string | number | null }>;
      return ativosRows.filter((r) => !setComGrupo.has(String(r.sku_codigo_omie))).length;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (c) Fila de aplicação Omie pendente
  const { data: filaPendente } = useQuery({
    queryKey: ["cadastros-fila-pendente", empresa],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("fila_aplicacao_omie" as never)
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa)
        .eq("status", "pendente");
      if (error) return 0;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (d) Grupos de produção ativos
  const { data: gruposAtivos } = useQuery({
    queryKey: ["cadastros-grupos-ativos", empresa],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("fornecedor_grupo_producao")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa);
      if (error) return 0;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const cards = [
    {
      label: "Pedidos de compra abertos",
      value: pedidosAbertos ?? 0,
      icon: ShoppingCart,
      tone: pedidosAbertos && pedidosAbertos > 0 ? "text-primary" : "text-muted-foreground",
      border: pedidosAbertos && pedidosAbertos > 0 ? "border-primary/40" : "border-border",
    },
    {
      label: "SKUs sem cadeia logística",
      value: skusSemCadeia ?? 0,
      icon: AlertTriangle,
      tone: skusSemCadeia && skusSemCadeia > 0 ? "text-warning" : "text-muted-foreground",
      border: skusSemCadeia && skusSemCadeia > 0 ? "border-warning/40" : "border-border",
    },
    {
      label: "Fila de aplicação Omie",
      value: filaPendente ?? 0,
      icon: Send,
      tone: filaPendente && filaPendente > 0 ? "text-primary" : "text-muted-foreground",
      border: filaPendente && filaPendente > 0 ? "border-primary/40" : "border-border",
    },
    {
      label: "Grupos de produção",
      value: gruposAtivos ?? 0,
      icon: Layers,
      tone: gruposAtivos && gruposAtivos > 0 ? "text-primary" : "text-muted-foreground",
      border: gruposAtivos && gruposAtivos > 0 ? "border-primary/40" : "border-border",
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

export default function AdminReposicaoCadastros() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "pedidos";
  const [empresa, setEmpresa] = useState("OBEN");

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  return (
    <ReposicaoEmpresaProvider value={{ empresa, setEmpresa }}>
      <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
        <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <Database className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Cadastros & Config</h1>
              <p className="text-sm text-muted-foreground">
                Grupos de produção, cadeia logística, mapeamento de SKUs e pedidos sugeridos.
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
          <TabsList className="grid grid-cols-2 sm:grid-cols-5 w-full">
            <TabsTrigger value="pedidos">
              <ShoppingCart className="h-4 w-4 mr-1" /> Pedidos
            </TabsTrigger>
            <TabsTrigger value="cadeia">
              <Network className="h-4 w-4 mr-1" /> Cadeia Logística
            </TabsTrigger>
            <TabsTrigger value="grupos">
              <Layers className="h-4 w-4 mr-1" /> Grupos
            </TabsTrigger>
            <TabsTrigger value="mapeamento">
              <Link2 className="h-4 w-4 mr-1" /> Mapeamento de SKUs
            </TabsTrigger>
            <TabsTrigger value="aplicacao">
              <Send className="h-4 w-4 mr-1" /> Aplicação Omie
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pedidos" className="m-0">
            <HistoricoPedidosCiclos />
          </TabsContent>

          <TabsContent value="cadeia" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoCadeiaLogistica />
            </Suspense>
          </TabsContent>

          <TabsContent value="grupos" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoGruposProducao />
            </Suspense>
          </TabsContent>

          <TabsContent value="mapeamento" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminSkuMapeamento />
            </Suspense>
          </TabsContent>

          <TabsContent value="aplicacao" className="m-0">
            <Suspense fallback={<TabFallback />}>
              <AdminReposicaoAplicacao />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </ReposicaoEmpresaProvider>
  );
}

/* ─── Histórico de Pedidos por Ciclo ─── */
type CicloRow = {
  data_ciclo: string;
  fornecedor_nome: string | null;
  status: string | null;
  valor_total: number | null;
  num_skus: number | null;
};

function statusVariant(status: string | null): "success" | "warning" | "destructive" | "secondary" {
  const s = (status ?? "").toLowerCase();
  if (s === "disparado") return "success";
  if (s === "pendente") return "warning";
  if (s === "bloqueado") return "destructive";
  return "secondary";
}

function HistoricoPedidosCiclos() {
  const { empresa } = useReposicaoEmpresa();
  const today = new Date();
  const past = new Date();
  past.setDate(today.getDate() - 30);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [de, setDe] = useState(fmt(past));
  const [ate, setAte] = useState(fmt(today));
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const { data, isLoading } = useQuery({
    queryKey: ["historico-ciclos", empresa, de, ate],
    queryFn: async (): Promise<CicloRow[]> => {
      const { data, error } = await supabase
        .from("pedido_compra_sugerido")
        .select("data_ciclo, fornecedor_nome, status, valor_total, num_skus")
        .eq("empresa", empresa)
        .gte("data_ciclo", de)
        .lte("data_ciclo", ate)
        .order("data_ciclo", { ascending: false })
        .limit(2000);
      if (error) return [];
      return (data ?? []) as CicloRow[];
    },
    staleTime: 30000,
  });

  const rows = data ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageRows = useMemo(
    () => rows.slice(page * pageSize, page * pageSize + pageSize),
    [rows, page]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Histórico de Pedidos por Ciclo</CardTitle>
        <CardDescription>Todos os ciclos de compra agrupados por data</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="data-de" className="text-xs">De</Label>
            <Input
              id="data-de"
              type="date"
              value={de}
              onChange={(e) => { setDe(e.target.value); setPage(0); }}
              className="w-[160px]"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="data-ate" className="text-xs">Até</Label>
            <Input
              id="data-ate"
              type="date"
              value={ate}
              onChange={(e) => { setAte(e.target.value); setPage(0); }}
              className="w-[160px]"
            />
          </div>
        </div>

        {isLoading ? (
          <PageSkeleton variant="list" />
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Nenhum ciclo encontrado para o período
          </div>
        ) : (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data do Ciclo</TableHead>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">N SKUs</TableHead>
                    <TableHead className="text-right">Valor Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((r, i) => (
                    <TableRow key={`${r.data_ciclo}-${r.fornecedor_nome}-${i}`}>
                      <TableCell className="font-mono text-xs">
                        {r.data_ciclo ? new Date(r.data_ciclo).toLocaleDateString("pt-BR") : "—"}
                      </TableCell>
                      <TableCell>{r.fornecedor_nome ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(r.status)}>{r.status ?? "—"}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{r.num_skus ?? 0}</TableCell>
                      <TableCell className="text-right">
                        {(r.valor_total ?? 0).toLocaleString("pt-BR", {
                          style: "currency",
                          currency: "BRL",
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {rows.length} ciclos · página {page + 1} de {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                >
                  Próxima
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
