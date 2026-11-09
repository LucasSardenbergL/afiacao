import { lazy, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDias, hojeSP } from "@/lib/time/sp-day";
import { Database, ShoppingCart, Network, Layers, Building2, AlertTriangle, Link2 } from "lucide-react";
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
import { KpiContagem } from "@/components/reposicao/KpiContagem";
import { AvisoLeituraFalhou } from "@/components/leitura/AvisoLeituraFalhou";
import { desatualizado, estadoDeLeitura, naoConsegui } from "@/lib/leitura/estado-de-leitura";

// Reaproveita as telas originais para tabs auxiliares — mesmas queries Supabase.
const AdminReposicaoCadeiaLogistica = lazy(() => import("./AdminReposicaoCadeiaLogistica"));
const AdminReposicaoGruposProducao = lazy(() => import("./AdminReposicaoGruposProducao"));
const AdminSkuMapeamento = lazy(() => import("./AdminSkuMapeamento"));

const TabFallback = () => <PageSkeleton variant="auto" />;

/* ─── KPI Cards ─── */
function KpiCards() {
  const { empresa } = useReposicaoEmpresa();

  // Os três `queryFn` LANÇAM no erro (plano v7, C8): com `if (error) return 0` a query ficava
  // `success` e "SKUs sem cadeia logística: 0" afirmava "tudo mapeado" quando a leitura caiu.
  // Quem separa carregando / falhou / zero medido é o <KpiContagem>.

  // (a) Pedidos de compra abertos (sugeridos/em edição)
  const pedidosAbertos = useQuery({
    queryKey: ["cadastros-pedidos-abertos", empresa],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("pedido_compra_sugerido")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa)
        .in("status", ["sugerido", "em_edicao", "rascunho"]);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (b) SKUs sem cadeia logística mapeada — sku_parametros ativos sem grupo de produção.
  // Anti-join no cliente sobre duas leituras: se QUALQUER uma falha, a diferença é desconhecida
  // (com a lista de grupos vazia por erro, todo SKU ativo viraria "sem cadeia").
  const skusSemCadeia = useQuery({
    queryKey: ["cadastros-skus-sem-cadeia", empresa],
    queryFn: async () => {
      const { data: comGrupo, error: e1 } = await supabase
        .from("sku_grupo_producao")
        .select("sku_codigo_omie")
        .eq("empresa", empresa);
      if (e1) throw e1;
      const grupoRows = (comGrupo ?? []);
      const setComGrupo = new Set(grupoRows.map((r) => String(r.sku_codigo_omie)));

      const { data: ativos, error: e2 } = await supabase
        .from("sku_parametros")
        .select("sku_codigo_omie")
        .eq("empresa", empresa)
        .eq("ativo", true);
      if (e2) throw e2;

      const ativosRows = (ativos ?? []);
      return ativosRows.filter((r) => !setComGrupo.has(String(r.sku_codigo_omie))).length;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // (c) Grupos de produção ativos
  const gruposAtivos = useQuery({
    queryKey: ["cadastros-grupos-ativos", empresa],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("fornecedor_grupo_producao")
        .select("*", { count: "exact", head: true })
        .eq("empresa", empresa);
      if (error) throw error;
      return count ?? 0;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
      <KpiContagem
        id="pedidos-abertos"
        label="Pedidos de compra abertos"
        icon={ShoppingCart}
        query={pedidosAbertos}
        tone="text-primary"
        border="border-primary/40"
      />
      <KpiContagem
        id="skus-sem-cadeia"
        label="SKUs sem cadeia logística"
        icon={AlertTriangle}
        query={skusSemCadeia}
        tone="text-status-warning"
        border="border-status-warning/40"
      />
      <KpiContagem
        id="grupos-producao"
        label="Grupos de produção"
        icon={Layers}
        query={gruposAtivos}
        tone="text-primary"
        border="border-primary/40"
      />
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
          <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full">
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
  // A janela padrão do histórico de ciclos em dias de SP — o dia de data_ciclo.
  const hoje = hojeSP();
  const [de, setDe] = useState(addDias(hoje, -30));
  const [ate, setAte] = useState(hoje);
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const historico = useQuery({
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
      // Lança: com `return []` a falha virava "Nenhum ciclo encontrado para o período".
      if (error) throw error;
      return (data ?? []) as CicloRow[];
    },
    staleTime: 30000,
  });

  const estadoHistorico = estadoDeLeitura(historico);
  const temHistorico = historico.data !== undefined;
  const historicoVelho = desatualizado(historico, temHistorico);
  const rows = useMemo(() => historico.data ?? [], [historico.data]);
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

        {historicoVelho && (
          <AvisoLeituraFalhou
            oque="a atualização do histórico de ciclos (a lista abaixo é da leitura anterior)"
            estado={historicoVelho}
            testId="aviso-historico-ciclos-desatualizado"
          />
        )}
        {!temHistorico && naoConsegui(estadoHistorico) ? (
          <AvisoLeituraFalhou
            oque="o histórico de ciclos"
            estado={estadoHistorico}
            variante="bloco"
            testId="aviso-historico-ciclos"
          />
        ) : !temHistorico ? (
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
                      {/* ausente ≠ zero: sem valor na linha, "—" (não "0" nem "R$ 0,00") */}
                      <TableCell className="text-right">{r.num_skus ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {r.valor_total == null
                          ? "—"
                          : r.valor_total.toLocaleString("pt-BR", {
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
