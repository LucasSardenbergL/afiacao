import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { format, subDays } from "date-fns";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  CalendarRange,
  AlertTriangle,
  Download,
  ChevronDown,
  ChevronRight,
  ScrollText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ProcessoComprasStepper } from "@/components/reposicao/ProcessoComprasStepper";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Reaproveita as telas originais como conteúdo das abas — mesmas queries Supabase.
const AdminReposicaoPedidos = lazy(() => import("./AdminReposicaoPedidos"));
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

// ============================================================================
// CSV utils
// ============================================================================

function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const csv = [headers.join(";"), ...rows.map((r) => r.map(toCsvValue).join(";"))].join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// Audit log
// ============================================================================

async function logAudit(params: {
  userId: string | null;
  action: string;
  result: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabase.from("cockpit_audit_log" as any).insert({
      user_id: params.userId,
      action: params.action,
      result: params.result,
      metadata: params.metadata ?? {},
    });
  } catch {
    // não bloqueia a UI se a auditoria falhar
  }
}

function AuditLogSection() {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(20);

  type LogRow = {
    id: string;
    created_at: string;
    user_id: string | null;
    action: string;
    result: string;
    metadata: Record<string, unknown> | null;
  };

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["cockpit-audit-log", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cockpit_audit_log" as any)
        .select("id,created_at,user_id,action,result,metadata")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as unknown) as LogRow[];
    },
    enabled: open,
  });

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center justify-between p-4 hover:bg-muted/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Log de Auditoria</span>
            </div>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            {isLoading ? (
              <TabFallback />
            ) : rows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Nenhum registro de auditoria.
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quando</TableHead>
                      <TableHead>Usuário</TableHead>
                      <TableHead>Ação</TableHead>
                      <TableHead>Resultado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const isErr = r.result.toLowerCase().startsWith("erro");
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {new Date(r.created_at).toLocaleString("pt-BR")}
                          </TableCell>
                          <TableCell className="text-xs font-mono">
                            {r.user_id ? r.user_id.slice(0, 8) : "—"}
                          </TableCell>
                          <TableCell className="text-sm">{r.action}</TableCell>
                          <TableCell>
                            <Badge variant={isErr ? "destructive" : "secondary"}>
                              {r.result}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="flex justify-center pt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLimit((l) => l + 20);
                      refetch();
                    }}
                  >
                    Ver mais
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// ============================================================================
// Ciclos anteriores
// ============================================================================

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

// ============================================================================
// Stepper / etapa atual
// ============================================================================

function useCurrentStep() {
  const today = format(new Date(), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["cockpit-current-step", EMPRESA, today],
    queryFn: async () => {
      const oport = await supabase
        .from("v_oportunidade_economica_hoje" as any)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA);
      if (oport.error) throw oport.error;

      const params = await supabase
        .from("sku_parametros" as any)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("ativo", true)
        .is("aprovado_em", null);
      if (params.error) throw params.error;

      const pedidos = await supabase
        .from("pedido_compra_sugerido" as any)
        .select("status")
        .eq("empresa", EMPRESA)
        .eq("data_ciclo", today);
      if (pedidos.error) throw pedidos.error;

      const statuses = (((pedidos.data ?? []) as unknown) as Array<{ status: string | null }>).map(
        (r) => r.status,
      );
      const hasPendentes = statuses.some(
        (s) => s === "pendente_aprovacao" || s === "bloqueado_guardrail",
      );
      const hasAprovados = statuses.some((s) => s === "aprovado_aguardando_disparo");
      const hasDisparados = statuses.some((s) => s === "disparado");

      if ((oport.count ?? 0) > 0) return 1;
      if ((params.count ?? 0) > 0) return 2;
      if (hasPendentes) return 3;
      if (hasAprovados) return 4;
      if (hasDisparados) return 5;
      return 3;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

const TAB_VALUES = ["ciclohoje", "aplicaromie", "anteriores"] as const;
type TabValue = (typeof TAB_VALUES)[number];

// ============================================================================
// Main page
// ============================================================================

export default function AdminReposicaoCockpit() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: currentStep = 3,
    isLoading: isLoadingStep,
    isError: stepError,
    refetch: refetchStep,
    isFetching: isFetchingStep,
  } = useCurrentStep();

  const defaultTab: TabValue = currentStep === 4 ? "aplicaromie" : "ciclohoje";
  const tab: TabValue = (TAB_VALUES as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as TabValue)
    : defaultTab;

  useEffect(() => {
    if (tabParam === "oportunidades") {
      navigate("/admin/reposicao/oportunidades", { replace: true });
    }
  }, [tabParam, navigate]);

  // ------ Realtime: invalida queries quando dados mudam no Supabase --------
  useEffect(() => {
    const channel = supabase
      .channel("cockpit-reposicao-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pedido_compra_sugerido" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
          queryClient.invalidateQueries({ queryKey: ["cockpit-ciclos-anteriores"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-aplicacao"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-historico"] });
          toast("Dados atualizados automaticamente", { duration: 1800 });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sku_parametros" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
          queryClient.invalidateQueries({ queryKey: ["reposicao-aplicacao"] });
          toast("Dados atualizados automaticamente", { duration: 1800 });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const handleTab = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  const handleStepClick = (step: number) => {
    switch (step) {
      case 1:
        navigate("/admin/reposicao/oportunidades");
        break;
      case 2:
        navigate("/admin/reposicao/parametros");
        break;
      case 3:
        handleTab("ciclohoje");
        break;
      case 4:
        handleTab("aplicaromie");
        break;
      case 5:
        handleTab("ciclohoje");
        break;
    }
  };

  // ------ Export CSV por aba -------------------------------------------------
  const [isExporting, setIsExporting] = useState(false);

  const handleExportCsv = async () => {
    if (isExporting) return;
    setIsExporting(true);
    const today = format(new Date(), "yyyy-MM-dd");
    const filename = `cockpit-${tab}-${today}.csv`;
    try {
      if (tab === "ciclohoje") {
        const { data, error } = await supabase
          .from("pedido_compra_sugerido" as any)
          .select(
            "fornecedor_nome,grupo_codigo,num_skus,valor_total,status,aprovado_em,horario_disparo_real",
          )
          .eq("empresa", EMPRESA)
          .eq("data_ciclo", today);
        if (error) throw error;
        const rows = (((data ?? []) as unknown) as Array<{
          fornecedor_nome: string | null;
          grupo_codigo: string | null;
          num_skus: number | null;
          valor_total: number | null;
          status: string | null;
          aprovado_em: string | null;
        }>).map((r) => [
          r.grupo_codigo ?? "",
          r.fornecedor_nome ?? "",
          r.fornecedor_nome ?? "",
          r.num_skus ?? 0,
          r.aprovado_em ? r.num_skus ?? 0 : 0,
          r.status ?? "",
        ]);
        downloadCsv(
          filename,
          ["SKU", "Descrição", "Fornecedor", "Qtd sugerida", "Qtd aprovada", "Status"],
          rows,
        );
      } else if (tab === "aplicaromie") {
        const { data, error } = await supabase
          .from("sku_parametros" as any)
          .select(
            "sku_codigo_omie,sku_descricao,estoque_minimo,estoque_minimo_omie,aplicar_no_omie,ultima_aplicacao_omie",
          )
          .eq("empresa", EMPRESA)
          .eq("ativo", true);
        if (error) throw error;
        const rows = (((data ?? []) as unknown) as Array<{
          sku_codigo_omie: number | null;
          sku_descricao: string | null;
          estoque_minimo: number | null;
          estoque_minimo_omie: number | null;
          aplicar_no_omie: boolean | null;
          ultima_aplicacao_omie: string | null;
        }>).map((r) => [
          r.sku_codigo_omie ?? "",
          r.sku_descricao ?? "",
          "estoque_minimo",
          r.estoque_minimo_omie ?? "",
          r.estoque_minimo ?? "",
          r.ultima_aplicacao_omie
            ? "aplicado"
            : r.aplicar_no_omie
              ? "pronto_para_aplicar"
              : "pendente",
        ]);
        downloadCsv(
          filename,
          ["SKU", "Descrição", "Parâmetro", "Valor atual", "Valor novo", "Status"],
          rows,
        );
      } else {
        const fim = new Date();
        const inicio = subDays(fim, 29);
        const { data, error } = await supabase
          .from("pedido_compra_sugerido" as any)
          .select("data_ciclo,num_skus,valor_total,status")
          .eq("empresa", EMPRESA)
          .gte("data_ciclo", format(inicio, "yyyy-MM-dd"))
          .lte("data_ciclo", format(fim, "yyyy-MM-dd"));
        if (error) throw error;
        const map = new Map<
          string,
          { skus: number; valor: number; statuses: Set<string> }
        >();
        for (const r of (((data ?? []) as unknown) as Array<{
          data_ciclo: string;
          num_skus: number | null;
          valor_total: number | null;
          status: string | null;
        }>)) {
          if (!map.has(r.data_ciclo)) {
            map.set(r.data_ciclo, { skus: 0, valor: 0, statuses: new Set() });
          }
          const acc = map.get(r.data_ciclo)!;
          acc.skus += Number(r.num_skus ?? 0);
          acc.valor += Number(r.valor_total ?? 0);
          if (r.status) acc.statuses.add(r.status);
        }
        const rows = Array.from(map.entries())
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([data, v]) => [
            formatDate(data),
            v.skus,
            v.valor.toFixed(2).replace(".", ","),
            Array.from(v.statuses).join(","),
          ]);
        downloadCsv(filename, ["Data", "SKUs", "Total pedido", "Status"], rows);
      }
      await logAudit({
        userId: user?.id ?? null,
        action: "CSV exportado",
        result: "Sucesso",
        metadata: { tab, filename },
      });
      toast.success("CSV exportado");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "CSV exportado",
        result: `Erro: ${msg}`,
        metadata: { tab },
      });
      toast.error("Falha ao exportar CSV");
    } finally {
      setIsExporting(false);
    }
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

      {stepError && (
        <Alert variant="default" className="border-amber-500/40 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle>Etapa atual indisponível</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-3 flex-wrap">
            <span>Não foi possível calcular a etapa atual. Exibindo dados em cache.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetchStep()}
              disabled={isFetchingStep}
            >
              {isFetchingStep ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  Tentando...
                </>
              ) : (
                "Tentar novamente"
              )}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <ProcessoComprasStepper
        currentStep={currentStep}
        onStepClick={handleStepClick}
        isLoading={isLoadingStep}
      />

      <Tabs value={tab} onValueChange={handleTab} className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList className="grid grid-cols-3 w-full sm:w-auto">
            <TabsTrigger value="ciclohoje">Ciclo de hoje</TabsTrigger>
            <TabsTrigger value="aplicaromie">Aplicar no Omie</TabsTrigger>
            <TabsTrigger value="anteriores">Ciclos anteriores</TabsTrigger>
          </TabsList>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportCsv}
            disabled={isExporting}
          >
            {isExporting ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-1.5" />
            )}
            Exportar CSV
          </Button>
        </div>

        <TabsContent value="ciclohoje" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoPedidos />
          </Suspense>
        </TabsContent>

        <TabsContent value="aplicaromie" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoAplicacao />
          </Suspense>
        </TabsContent>

        <TabsContent value="anteriores" className="m-0">
          <Suspense fallback={<TabFallback />}>
            <AdminReposicaoHistorico />
          </Suspense>
        </TabsContent>
      </Tabs>

      <AuditLogSection />
    </div>
  );
}
