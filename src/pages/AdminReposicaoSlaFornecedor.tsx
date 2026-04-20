import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowDown, ArrowRight, ArrowUp, Download, Search } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";

const EMPRESA = "OBEN";

type SlaStatus =
  | "cumprindo"
  | "limite"
  | "violando"
  | "critico"
  | "sem_sla_teorico"
  | "poucos_dados";

type Tendencia = "melhorando" | "estavel" | "piorando";

interface ForCompliance {
  empresa: string;
  fornecedor_nome: string;
  skus_avaliados: number;
  cumprindo: number;
  limite: number;
  violando: number;
  critico: number;
  sem_sla: number;
  poucos_dados: number;
  pct_compliance: number | null;
  lt_teorico_medio: number | null;
  lt_observado_medio: number | null;
}

interface SkuCompliance {
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  grupo_producao: string | null;
  grupo_descricao: string | null;
  lt_teorico: number | null;
  lt_observado_medio: number | null;
  lt_obs_recente_5: number | null;
  lt_obs_anterior_5: number | null;
  n_observacoes: number | null;
  ultimo_recebimento: string | null;
  desvio_pct: number | null;
  status_sla: SlaStatus;
  tendencia: Tendencia;
}

const STATUS_LABEL: Record<SlaStatus, string> = {
  cumprindo: "Cumprindo",
  limite: "No limite",
  violando: "Violando",
  critico: "Crítico",
  sem_sla_teorico: "Sem SLA",
  poucos_dados: "Poucos dados",
};

const STATUS_VARIANT: Record<SlaStatus, "success" | "warning" | "info" | "destructive" | "outline"> = {
  cumprindo: "success",
  limite: "warning",
  violando: "warning",
  critico: "destructive",
  sem_sla_teorico: "outline",
  poucos_dados: "outline",
};

const STATUS_RANK: Record<SlaStatus, number> = {
  critico: 0,
  violando: 1,
  limite: 2,
  cumprindo: 3,
  poucos_dados: 4,
  sem_sla_teorico: 5,
};

const fmtNum = (v: number | null | undefined, dec = 1) =>
  v == null ? "—" : Number(v).toFixed(dec);

const fmtData = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("pt-BR") : "—";

const TendenciaIcon = ({ t }: { t: Tendencia }) => {
  if (t === "piorando") return <ArrowUp className="h-3.5 w-3.5 text-destructive" aria-label="piorando" />;
  if (t === "melhorando") return <ArrowDown className="h-3.5 w-3.5 text-success" aria-label="melhorando" />;
  return <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-label="estável" />;
};

const desvioColorClass = (pct: number | null) => {
  if (pct == null) return "text-muted-foreground";
  if (pct <= 10) return "text-success font-medium";
  if (pct <= 25) return "text-warning font-medium";
  if (pct <= 50) return "text-warning font-semibold";
  return "text-destructive font-semibold";
};

const cardTone = (pct: number | null) => {
  if (pct == null) return "border-border";
  if (pct >= 90) return "border-success/40 bg-success/5";
  if (pct >= 70) return "border-warning/40 bg-warning/5";
  return "border-destructive/40 bg-destructive/5";
};

export default function AdminReposicaoSlaFornecedor() {
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>("__all__");
  const [filtroStatus, setFiltroStatus] = useState<SlaStatus[]>([
    "cumprindo",
    "limite",
    "violando",
    "critico",
  ]);
  const [filtroTendencia, setFiltroTendencia] = useState<string>("__all__");
  const [filtroGrupo, setFiltroGrupo] = useState<string>("__all__");
  const [busca, setBusca] = useState("");
  const [skuDetalhe, setSkuDetalhe] = useState<SkuCompliance | null>(null);

  // Compliance por fornecedor
  const { data: fornecedores, isLoading: loadingFor } = useQuery({
    queryKey: ["sla-fornecedor", EMPRESA],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_fornecedor_sla_compliance")
        .select("*")
        .eq("empresa", EMPRESA)
        .order("pct_compliance", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as ForCompliance[];
    },
  });

  // Compliance por SKU
  const { data: skus, isLoading: loadingSkus } = useQuery({
    queryKey: ["sla-sku", EMPRESA],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_sku_sla_compliance")
        .select("*")
        .eq("empresa", EMPRESA)
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as SkuCompliance[];
    },
  });

  // Histórico do SKU selecionado
  const { data: historico, isLoading: loadingHist } = useQuery({
    enabled: !!skuDetalhe,
    queryKey: ["sla-hist", skuDetalhe?.sku_codigo_omie],
    queryFn: async () => {
      if (!skuDetalhe) return [];
      const { data, error } = await (supabase as any)
        .from("sku_leadtime_history")
        .select("t4_data_recebimento, lt_bruto_dias_uteis, lt_faturamento_dias_uteis, lt_logistica_dias_uteis")
        .eq("sku_codigo_omie", Number(skuDetalhe.sku_codigo_omie))
        .not("lt_bruto_dias_uteis", "is", null)
        .order("t4_data_recebimento", { ascending: false })
        .limit(15);
      if (error) throw error;
      return ((data ?? []) as any[])
        .reverse()
        .map((r) => ({
          data: r.t4_data_recebimento
            ? new Date(r.t4_data_recebimento).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
            : "",
          lt: r.lt_bruto_dias_uteis != null ? Number(r.lt_bruto_dias_uteis) : null,
          faturamento: r.lt_faturamento_dias_uteis != null ? Number(r.lt_faturamento_dias_uteis) : null,
          logistica: r.lt_logistica_dias_uteis != null ? Number(r.lt_logistica_dias_uteis) : null,
        }));
    },
  });

  const grupos = useMemo(
    () => Array.from(new Set((skus ?? []).map((s) => s.grupo_producao).filter(Boolean))).sort() as string[],
    [skus],
  );

  const skusFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (skus ?? [])
      .filter((s) => filtroStatus.includes(s.status_sla))
      .filter((s) => filtroFornecedor === "__all__" || s.fornecedor_nome === filtroFornecedor)
      .filter((s) => filtroTendencia === "__all__" || s.tendencia === filtroTendencia)
      .filter((s) => filtroGrupo === "__all__" || s.grupo_producao === filtroGrupo)
      .filter(
        (s) =>
          !q ||
          s.sku_codigo_omie.toLowerCase().includes(q) ||
          (s.sku_descricao ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const r = STATUS_RANK[a.status_sla] - STATUS_RANK[b.status_sla];
        if (r !== 0) return r;
        return (b.desvio_pct ?? -Infinity) - (a.desvio_pct ?? -Infinity);
      });
  }, [skus, filtroStatus, filtroFornecedor, filtroTendencia, filtroGrupo, busca]);

  const fornecedoresOptions = useMemo(
    () => Array.from(new Set((skus ?? []).map((s) => s.fornecedor_nome).filter(Boolean))).sort() as string[],
    [skus],
  );

  const exportCsv = () => {
    if (!fornecedores?.length) return;
    const head = [
      "fornecedor",
      "skus_avaliados",
      "pct_compliance",
      "cumprindo",
      "limite",
      "violando",
      "critico",
      "lt_teorico_medio",
      "lt_observado_medio",
    ];
    const rows = fornecedores.map((f) =>
      [
        `"${f.fornecedor_nome.replace(/"/g, '""')}"`,
        f.skus_avaliados,
        f.pct_compliance ?? "",
        f.cumprindo,
        f.limite,
        f.violando,
        f.critico,
        f.lt_teorico_medio ?? "",
        f.lt_observado_medio ?? "",
      ].join(","),
    );
    const blob = new Blob([head.join(",") + "\n" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sla-fornecedor-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleStatus = (s: SlaStatus) => {
    setFiltroStatus((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SLA de fornecedor</h1>
          <p className="text-sm text-muted-foreground">
            Compliance de lead time por SKU e por fornecedor — evidência objetiva pra negociação.
          </p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!fornecedores?.length}>
          <Download className="h-4 w-4 mr-2" /> Exportar CSV
        </Button>
      </div>

      {/* Cards de compliance global */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {loadingFor &&
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
        {!loadingFor &&
          fornecedores?.map((f) => (
            <Card key={f.fornecedor_nome} className={cardTone(f.pct_compliance)}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between gap-2">
                  <span className="truncate" title={f.fornecedor_nome}>{f.fornecedor_nome}</span>
                  <Badge variant="outline" className="shrink-0">{f.skus_avaliados} SKUs</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-3xl font-bold">
                  {f.pct_compliance != null ? `${f.pct_compliance}%` : "—"}
                  <span className="text-xs font-normal text-muted-foreground ml-1">compliance</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  LT teórico: <span className="font-mono">{fmtNum(f.lt_teorico_medio)}d</span> · observado:{" "}
                  <span className="font-mono">{fmtNum(f.lt_observado_medio)}d</span>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Badge variant="success">{f.cumprindo} ok</Badge>
                  <Badge variant="warning">{f.limite} limite</Badge>
                  <Badge variant="warning">{f.violando} viol.</Badge>
                  <Badge variant="destructive">{f.critico} crít.</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        {!loadingFor && (fornecedores?.length ?? 0) === 0 && (
          <Card className="md:col-span-3">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nenhum fornecedor com dados de SLA disponíveis ainda.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Tabela detalhada por SKU */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Compliance por SKU</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Filtros */}
          <div className="flex flex-wrap gap-3 items-end">
            <div className="w-[220px]">
              <Label className="text-xs">Fornecedor</Label>
              <Select value={filtroFornecedor} onValueChange={setFiltroFornecedor}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  {fornecedoresOptions.map((f) => (
                    <SelectItem key={f} value={f}>{f}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[150px]">
              <Label className="text-xs">Tendência</Label>
              <Select value={filtroTendencia} onValueChange={setFiltroTendencia}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todas</SelectItem>
                  <SelectItem value="melhorando">Melhorando</SelectItem>
                  <SelectItem value="estavel">Estável</SelectItem>
                  <SelectItem value="piorando">Piorando</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-[180px]">
              <Label className="text-xs">Grupo de produção</Label>
              <Select value={filtroGrupo} onValueChange={setFiltroGrupo}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  {grupos.map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs">Buscar SKU</Label>
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-7"
                  placeholder="Código ou descrição"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Status multi-select como chips */}
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground self-center mr-1">Status:</span>
            {(["cumprindo", "limite", "violando", "critico", "poucos_dados", "sem_sla_teorico"] as SlaStatus[]).map(
              (s) => {
                const active = filtroStatus.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() => toggleStatus(s)}
                    className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:bg-muted"
                    }`}
                  >
                    {STATUS_LABEL[s]}
                  </button>
                );
              },
            )}
          </div>

          {/* Tabela */}
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Grupo</TableHead>
                  <TableHead className="text-right">LT teór.</TableHead>
                  <TableHead className="text-right">LT obs.</TableHead>
                  <TableHead className="text-right">Recente 5</TableHead>
                  <TableHead className="text-right">Desvio</TableHead>
                  <TableHead>Último receb.</TableHead>
                  <TableHead className="text-right">N obs.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingSkus &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={9}><Skeleton className="h-6 w-full" /></TableCell>
                    </TableRow>
                  ))}
                {!loadingSkus && skusFiltrados.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
                      Nenhum SKU encontrado com os filtros atuais.
                    </TableCell>
                  </TableRow>
                )}
                {!loadingSkus &&
                  skusFiltrados.map((s) => {
                    const clicavel = (s.n_observacoes ?? 0) >= 3;
                    return (
                      <TableRow
                        key={`${s.empresa}-${s.sku_codigo_omie}`}
                        className={clicavel ? "cursor-pointer" : "opacity-90"}
                        onClick={() => clicavel && setSkuDetalhe(s)}
                      >
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[s.status_sla]}>{STATUS_LABEL[s.status_sla]}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">{s.sku_codigo_omie}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[280px]" title={s.sku_descricao ?? ""}>
                            {s.sku_descricao ?? "—"}
                          </div>
                        </TableCell>
                        <TableCell>
                          {s.grupo_producao ? (
                            <Badge variant="outline" className="text-xs">{s.grupo_producao}</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtNum(s.lt_teorico, 1)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtNum(s.lt_observado_medio, 1)}</TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1 font-mono text-xs">
                            {fmtNum(s.lt_obs_recente_5, 1)}
                            <TendenciaIcon t={s.tendencia} />
                          </div>
                        </TableCell>
                        <TableCell className={`text-right font-mono text-xs ${desvioColorClass(s.desvio_pct)}`}>
                          {s.desvio_pct == null ? "—" : `${s.desvio_pct > 0 ? "+" : ""}${s.desvio_pct}%`}
                        </TableCell>
                        <TableCell className="text-xs">{fmtData(s.ultimo_recebimento)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{s.n_observacoes ?? 0}</TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Modal: histórico do SKU */}
      <Dialog open={!!skuDetalhe} onOpenChange={(o) => !o && setSkuDetalhe(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{skuDetalhe?.sku_codigo_omie}</span>
                <span className="text-sm font-normal text-muted-foreground truncate">
                  {skuDetalhe?.sku_descricao}
                </span>
              </div>
            </DialogTitle>
          </DialogHeader>
          {skuDetalhe && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant={STATUS_VARIANT[skuDetalhe.status_sla]}>{STATUS_LABEL[skuDetalhe.status_sla]}</Badge>
                {skuDetalhe.fornecedor_nome && <Badge variant="outline">{skuDetalhe.fornecedor_nome}</Badge>}
                {skuDetalhe.grupo_producao && <Badge variant="outline">Grupo {skuDetalhe.grupo_producao}</Badge>}
                <Badge variant="outline">LT teórico: <span className="font-mono ml-1">{fmtNum(skuDetalhe.lt_teorico, 1)}d</span></Badge>
                <Badge variant="outline">Médio observado: <span className="font-mono ml-1">{fmtNum(skuDetalhe.lt_observado_medio, 1)}d</span></Badge>
              </div>
              <div className="h-[280px]">
                {loadingHist ? (
                  <Skeleton className="h-full w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={historico ?? []}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="data" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} label={{ value: "dias úteis", angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
                      <ReTooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {skuDetalhe.lt_teorico != null && (
                        <ReferenceLine
                          y={skuDetalhe.lt_teorico}
                          stroke="hsl(var(--muted-foreground))"
                          strokeDasharray="4 4"
                          label={{ value: `Teórico ${skuDetalhe.lt_teorico}d`, position: "right", fontSize: 10 }}
                        />
                      )}
                      <Line
                        type="monotone"
                        dataKey="faturamento"
                        name="Faturamento"
                        stroke="hsl(217 91% 70%)"
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        dot={{ r: 2.5 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="logistica"
                        name="Logística"
                        stroke="hsl(25 95% 65%)"
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        dot={{ r: 2.5 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                      <Line type="monotone" dataKey="lt" name="LT bruto" stroke="hsl(var(--primary))" strokeWidth={2.5} isAnimationActive={false} dot={(props: any) => {
                        const { cx, cy, payload } = props;
                        const violou = skuDetalhe.lt_teorico != null && payload.lt > skuDetalhe.lt_teorico * 1.25;
                        return (
                          <circle cx={cx} cy={cy} r={4} fill={violou ? "hsl(var(--destructive))" : "hsl(var(--primary))"} stroke="white" strokeWidth={1} />
                        );
                      }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Pontos vermelhos indicam recebimentos que ultrapassaram 25% do LT teórico. As linhas pontilhadas
                decompõem o LT em faturamento (fornecedor) e logística (transportadora) para diagnóstico.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
