import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Search, AlertTriangle, CheckCircle2, XCircle, EyeOff, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  ReferenceLine,
  Cell,
} from "recharts";

const PAGE_SIZE = 25;

type EventoOutlier = {
  id: number;
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  tipo: string;
  severidade: string;
  data_evento: string;
  valor_observado: number | null;
  valor_esperado: number | null;
  desvios_padrao: number | null;
  detalhes: any;
  status: string;
  decidido_em: string | null;
  decidido_por: string | null;
  justificativa_decisao: string | null;
  detectado_em: string | null;
};

const sevBadge = (sev: string) => {
  const map: Record<string, { variant: any; label: string }> = {
    critico: { variant: "destructive", label: "Crítico" },
    atencao: { variant: "warning", label: "Atenção" },
    info: { variant: "secondary", label: "Info" },
  };
  const cfg = map[sev] ?? { variant: "outline", label: sev };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
};

const statusBadge = (status: string) => {
  const map: Record<string, { variant: any; label: string }> = {
    pendente: { variant: "warning", label: "Pendente" },
    aceito: { variant: "success", label: "Aceito" },
    excluido: { variant: "destructive", label: "Excluído" },
    ignorado: { variant: "secondary", label: "Ignorado" },
  };
  const cfg = map[status] ?? { variant: "outline", label: status };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
};

const tipoLabel = (tipo: string) =>
  tipo === "venda_atipica"
    ? "Venda atípica"
    : tipo === "lt_atipico"
    ? "LT atípico"
    : tipo === "sku_sem_grupo"
    ? "SKU sem grupo"
    : tipo;

const fmt = (n: number | null | undefined, dec = 2) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

export default function AdminReposicaoAlertas() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [filtroTipo, setFiltroTipo] = useState<string>("__all__");
  const [filtroSev, setFiltroSev] = useState<string>("__all__");
  const [filtroStatus, setFiltroStatus] = useState<string>("pendente");
  const [busca, setBusca] = useState("");
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());

  const [drillEvento, setDrillEvento] = useState<EventoOutlier | null>(null);
  const [acaoConfirm, setAcaoConfirm] = useState<{ tipo: "aceitar" | "excluir" | "ignorar"; lote: boolean } | null>(null);
  const [justificativa, setJustificativa] = useState("");

  // Stats do cabeçalho
  const { data: stats } = useQuery({
    queryKey: ["outlier-stats"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eventos_outlier")
        .select("severidade, status, decidido_em");
      if (error) throw error;
      const rows = data ?? [];
      const hoje = new Date().toISOString().slice(0, 10);
      return {
        pendentes: rows.filter((r) => r.status === "pendente").length,
        criticos: rows.filter((r) => r.status === "pendente" && r.severidade === "critico").length,
        atencao: rows.filter((r) => r.status === "pendente" && r.severidade === "atencao").length,
        info: rows.filter((r) => r.status === "pendente" && r.severidade === "info").length,
        aceitosHoje: rows.filter((r) => r.status === "aceito" && r.decidido_em?.startsWith(hoje)).length,
        excluidosHoje: rows.filter((r) => r.status === "excluido" && r.decidido_em?.startsWith(hoje)).length,
      };
    },
    refetchInterval: 30000,
  });

  // Lista paginada
  const { data: lista, isLoading } = useQuery({
    queryKey: ["outliers-lista", page, filtroTipo, filtroSev, filtroStatus, busca],
    queryFn: async () => {
      let q = supabase
        .from("eventos_outlier")
        .select("*", { count: "exact" })
        .order("severidade", { ascending: true }) // critico < atencao < info alfabeticamente
        .order("desvios_padrao", { ascending: false, nullsFirst: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      if (filtroTipo !== "__all__") q = q.eq("tipo", filtroTipo);
      if (filtroSev !== "__all__") q = q.eq("severidade", filtroSev);
      if (filtroStatus !== "__all__") q = q.eq("status", filtroStatus);
      if (busca.trim()) {
        q = q.or(`sku_codigo_omie.ilike.%${busca.trim()}%,sku_descricao.ilike.%${busca.trim()}%`);
      }

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as EventoOutlier[], total: count ?? 0 };
    },
  });

  const totalPages = Math.max(1, Math.ceil((lista?.total ?? 0) / PAGE_SIZE));

  const isSemGrupo = drillEvento?.tipo === "sku_sem_grupo";

  // Drill-down: histórico de vendas (90d) ou LT
  const { data: historico } = useQuery({
    enabled: !!drillEvento && !isSemGrupo,
    queryKey: ["outlier-historico", drillEvento?.id],
    queryFn: async () => {
      if (!drillEvento) return null;
      if (drillEvento.tipo === "venda_atipica") {
        const desde = new Date();
        desde.setDate(desde.getDate() - 90);
        const { data, error } = await supabase
          .from("venda_items_history")
          .select("data_emissao, quantidade, nfe_chave_acesso")
          .eq("empresa", drillEvento.empresa as any)
          .eq("sku_codigo_omie", Number(drillEvento.sku_codigo_omie))
          .gte("data_emissao", desde.toISOString())
          .order("data_emissao", { ascending: true });
        if (error) throw error;
        // Agrega por dia
        const porDia = new Map<string, number>();
        (data ?? []).forEach((r: any) => {
          const dia = String(r.data_emissao).slice(0, 10);
          porDia.set(dia, (porDia.get(dia) ?? 0) + Number(r.quantidade));
        });
        const outlierDay = drillEvento.data_evento.slice(0, 10);
        return Array.from(porDia.entries())
          .map(([dia, q]) => ({ dia, qtde: q, isOutlier: dia === outlierDay }))
          .sort((a, b) => a.dia.localeCompare(b.dia));
      } else {
        const { data, error } = await (supabase as any)
          .from("sku_leadtime_history")
          .select("data_pedido, lt_bruto_dias_uteis")
          .eq("empresa", drillEvento.empresa)
          .eq("sku_codigo_omie", drillEvento.sku_codigo_omie)
          .order("data_pedido", { ascending: true });
        if (error) throw error;
        const outlierDay = drillEvento.data_evento.slice(0, 10);
        return (data ?? []).map((r: any, i: number) => ({
          idx: i + 1,
          dia: String(r.data_pedido).slice(0, 10),
          lt: Number(r.lt_bruto_dias_uteis),
          isOutlier: String(r.data_pedido).slice(0, 10) === outlierDay,
        }));
      }
    },
  });

  // Dados do SKU (drill seção 2)
  const { data: skuInfo } = useQuery({
    enabled: !!drillEvento,
    queryKey: ["outlier-sku", drillEvento?.sku_codigo_omie, drillEvento?.empresa],
    queryFn: async () => {
      if (!drillEvento) return null;
      const { data } = await (supabase as any)
        .from("sku_parametros")
        .select("classe_consolidada, demanda_media_diaria, demanda_sigma_diario, lt_medio_dias_uteis, preco_compra_real")
        .eq("empresa", drillEvento.empresa)
        .eq("sku_codigo_omie", Number(drillEvento.sku_codigo_omie))
        .maybeSingle();
      return data;
    },
  });

  // Impacto previsto
  const { data: impacto } = useQuery({
    enabled: !!drillEvento && !isSemGrupo,
    queryKey: ["outlier-impacto", drillEvento?.id],
    queryFn: async () => {
      if (!drillEvento) return null;
      const { data, error } = await (supabase as any).rpc("estimar_impacto_exclusao_outlier", {
        p_evento_id: drillEvento.id,
      });
      if (error) throw error;
      return data;
    },
  });

  // Mutation: resolver
  const resolverMut = useMutation({
    mutationFn: async ({ ids, decisao, just }: { ids: number[]; decisao: string; just: string }) => {
      const results = [];
      for (const id of ids) {
        const { data, error } = await (supabase as any).rpc("resolver_outlier", {
          p_evento_id: id,
          p_decisao: decisao,
          p_justificativa: just || null,
          p_usuario_email: user?.email || null,
        });
        if (error) throw error;
        results.push(data);
      }
      // Recálculo automático após exclusão
      if (decisao === "excluir") {
        try {
          await (supabase as any).rpc("atualizar_parametros_numericos_skus", { p_empresa: "OBEN" });
        } catch (e) {
          console.warn("Recálculo falhou:", e);
        }
      }
      return results;
    },
    onSuccess: (_, vars) => {
      toast.success(`${vars.ids.length} alerta(s) ${vars.decisao === "aceitar" ? "aceito(s)" : vars.decisao === "excluir" ? "excluído(s)" : "ignorado(s)"}`);
      qc.invalidateQueries({ queryKey: ["outliers-lista"] });
      qc.invalidateQueries({ queryKey: ["outlier-stats"] });
      qc.invalidateQueries({ queryKey: ["outlier-pendentes-count"] });
      setSelecionados(new Set());
      setDrillEvento(null);
      setAcaoConfirm(null);
      setJustificativa("");
    },
    onError: (err: any) => toast.error(err.message ?? "Erro ao resolver alerta"),
  });

  const todosSelecionavel = useMemo(
    () => (lista?.rows ?? []).filter((r) => r.status === "pendente" && r.severidade !== "critico"),
    [lista],
  );
  const todosMarcados = todosSelecionavel.length > 0 && todosSelecionavel.every((r) => selecionados.has(r.id));

  const toggleAll = () => {
    if (todosMarcados) setSelecionados(new Set());
    else setSelecionados(new Set(todosSelecionavel.map((r) => r.id)));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selecionados);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelecionados(next);
  };

  const executarAcao = () => {
    if (!acaoConfirm) return;
    const ids = acaoConfirm.lote ? Array.from(selecionados) : drillEvento ? [drillEvento.id] : [];
    if (ids.length === 0) return;
    resolverMut.mutate({ ids, decisao: acaoConfirm.tipo, just: justificativa });
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-warning" />
            Alertas de Outlier
          </h1>
          <p className="text-sm text-muted-foreground">Triagem humana de eventos estatísticos atípicos</p>
        </div>
      </div>

      {/* Estatísticas */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">Total pendentes</div>
            <div className="text-2xl font-bold">{stats?.pendentes ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="border-destructive/40">
          <CardContent className="pt-4">
            <div className="text-xs text-destructive">Críticos</div>
            <div className="text-2xl font-bold text-destructive">{stats?.criticos ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="border-warning/40">
          <CardContent className="pt-4">
            <div className="text-xs text-warning">Atenção</div>
            <div className="text-2xl font-bold text-warning">{stats?.atencao ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">Informativos</div>
            <div className="text-2xl font-bold">{stats?.info ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-success">Aceitos hoje</div>
            <div className="text-2xl font-bold">{stats?.aceitosHoje ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-xs text-destructive">Excluídos hoje</div>
            <div className="text-2xl font-bold">{stats?.excluidosHoje ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs">Buscar SKU</Label>
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  placeholder="Código ou descrição"
                  className="pl-8"
                  value={busca}
                  onChange={(e) => {
                    setBusca(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
            <div className="w-[160px]">
              <Label className="text-xs">Tipo</Label>
              <Select value={filtroTipo} onValueChange={(v) => { setFiltroTipo(v); setPage(1); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  <SelectItem value="venda_atipica">Venda atípica</SelectItem>
                  <SelectItem value="lt_atipico">LT atípico</SelectItem>
                  <SelectItem value="sku_sem_grupo">SKU sem grupo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-[140px]">
              <Label className="text-xs">Severidade</Label>
              <Select value={filtroSev} onValueChange={(v) => { setFiltroSev(v); setPage(1); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todas</SelectItem>
                  <SelectItem value="critico">Crítico</SelectItem>
                  <SelectItem value="atencao">Atenção</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-[140px]">
              <Label className="text-xs">Status</Label>
              <Select value={filtroStatus} onValueChange={(v) => { setFiltroStatus(v); setPage(1); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Todos</SelectItem>
                  <SelectItem value="pendente">Pendente</SelectItem>
                  <SelectItem value="aceito">Aceito</SelectItem>
                  <SelectItem value="excluido">Excluído</SelectItem>
                  <SelectItem value="ignorado">Ignorado</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {selecionados.size > 0 && (
            <div className="mt-4 flex gap-2 items-center bg-muted/50 p-3 rounded-md">
              <span className="text-sm font-medium">{selecionados.size} selecionado(s)</span>
              <Button size="sm" variant="default" onClick={() => setAcaoConfirm({ tipo: "aceitar", lote: true })}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Aceitar selecionados
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setAcaoConfirm({ tipo: "excluir", lote: true })}>
                <XCircle className="h-4 w-4 mr-1" /> Excluir selecionados
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelecionados(new Set())}>
                Limpar seleção
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lista */}
      <Card>
        <CardContent className="pt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={todosMarcados} onCheckedChange={toggleAll} disabled={todosSelecionavel.length === 0} />
                </TableHead>
                <TableHead>Severidade</TableHead>
                <TableHead>Data evento</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Observado</TableHead>
                <TableHead className="text-right">Esperado</TableHead>
                <TableHead className="text-right">σ</TableHead>
                <TableHead>Mensagem</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={12} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></TableCell></TableRow>
              )}
              {!isLoading && (lista?.rows.length ?? 0) === 0 && (
                <TableRow><TableCell colSpan={12} className="text-center py-8 text-muted-foreground">Nenhum alerta encontrado</TableCell></TableRow>
              )}
              {lista?.rows.map((r) => {
                const podeSelecionar = r.status === "pendente" && r.severidade !== "critico";
                return (
                  <TableRow key={r.id} className="hover:bg-muted/50">
                    <TableCell>
                      <Checkbox
                        checked={selecionados.has(r.id)}
                        onCheckedChange={() => toggleOne(r.id)}
                        disabled={!podeSelecionar}
                      />
                    </TableCell>
                    <TableCell>{sevBadge(r.severidade)}</TableCell>
                    <TableCell className="text-sm">{new Date(r.data_evento).toLocaleDateString("pt-BR")}</TableCell>
                    <TableCell className="font-mono text-xs">{r.sku_codigo_omie}</TableCell>
                    <TableCell className="text-sm max-w-[200px] truncate">{r.sku_descricao ?? "—"}</TableCell>
                    <TableCell><Badge variant="outline">{tipoLabel(r.tipo)}</Badge></TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(r.valor_observado, 0)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(r.valor_esperado, 1)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(r.desvios_padrao, 1)}</TableCell>
                    <TableCell className="text-xs max-w-[280px] truncate text-muted-foreground">{r.detalhes?.mensagem ?? "—"}</TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => setDrillEvento(r)}>Detalhes</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between mt-4">
            <div className="text-sm text-muted-foreground">{lista?.total ?? 0} alerta(s)</div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm">{page} / {totalPages}</span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Drill-down */}
      <Sheet open={!!drillEvento} onOpenChange={(o) => !o && setDrillEvento(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {drillEvento && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {sevBadge(drillEvento.severidade)}
                  <span>{tipoLabel(drillEvento.tipo)} — SKU {drillEvento.sku_codigo_omie}</span>
                </SheetTitle>
              </SheetHeader>

              <div className="space-y-5 mt-4">
                {/* Seção 1 */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">1. Contexto</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div><span className="text-muted-foreground">Data:</span> {new Date(drillEvento.data_evento).toLocaleDateString("pt-BR")}</div>
                    <div><span className="text-muted-foreground">Detectado:</span> {drillEvento.detectado_em ? new Date(drillEvento.detectado_em).toLocaleString("pt-BR") : "—"}</div>
                    <div className="pt-2 p-2 bg-muted/50 rounded text-xs">{drillEvento.detalhes?.mensagem ?? "Sem mensagem"}</div>
                  </CardContent>
                </Card>

                {/* Seção 2 */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">2. Dados do SKU</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div><span className="text-muted-foreground">Descrição:</span> {drillEvento.sku_descricao ?? "—"}</div>
                    <div><span className="text-muted-foreground">Classe:</span> {skuInfo?.classe_consolidada ?? "—"}</div>
                    <div><span className="text-muted-foreground">D (média/dia):</span> {fmt(skuInfo?.demanda_media_diaria, 2)}</div>
                    <div><span className="text-muted-foreground">σ atual:</span> {fmt(skuInfo?.demanda_sigma_diario, 2)}</div>
                    <div><span className="text-muted-foreground">LT médio:</span> {fmt(skuInfo?.lt_medio_dias_uteis, 1)} dias</div>
                    <div><span className="text-muted-foreground">Preço compra:</span> R$ {fmt(skuInfo?.preco_compra_real, 2)}</div>
                  </CardContent>
                </Card>

                {/* Seção 3 - Gráfico */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">3. Histórico</CardTitle></CardHeader>
                  <CardContent>
                    <div className="h-[220px]">
                      <ResponsiveContainer width="100%" height="100%">
                        {drillEvento.tipo === "venda_atipica" ? (
                          <BarChart data={(historico as any[]) ?? []}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="dia" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} />
                            <ReTooltip />
                            <Bar dataKey="qtde">
                              {((historico as any[]) ?? []).map((d, i) => (
                                <Cell key={i} fill={d.isOutlier ? "hsl(var(--destructive))" : "hsl(var(--primary))"} />
                              ))}
                            </Bar>
                          </BarChart>
                        ) : (
                          <ScatterChart>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="idx" tick={{ fontSize: 10 }} name="#" />
                            <YAxis dataKey="lt" tick={{ fontSize: 10 }} name="LT (dias)" />
                            <ReTooltip />
                            {impacto?.media_atual != null && (
                              <ReferenceLine y={impacto.media_atual} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                            )}
                            <Scatter data={(historico as any[]) ?? []}>
                              {((historico as any[]) ?? []).map((d, i) => (
                                <Cell key={i} fill={d.isOutlier ? "hsl(var(--destructive))" : "hsl(var(--primary))"} />
                              ))}
                            </Scatter>
                          </ScatterChart>
                        )}
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                {/* Seção 4 - Impacto */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">4. Impacto se excluir</CardTitle></CardHeader>
                  <CardContent className="text-sm space-y-1">
                    {impacto && !impacto.error ? (
                      <>
                        <div>σ atual: <span className="font-mono">{fmt(impacto.sigma_atual)}</span> → sem outlier: <span className="font-mono">{fmt(impacto.sigma_sem)}</span></div>
                        <div>Média atual: <span className="font-mono">{fmt(impacto.media_atual)}</span> → sem: <span className="font-mono">{fmt(impacto.media_sem)}</span></div>
                        {impacto.em_atual !== undefined && (
                          <div className="pt-2 p-2 bg-muted/50 rounded">
                            Estoque mínimo sugerido: <span className="font-mono">{impacto.em_atual}</span> → <span className="font-mono">{impacto.em_sem}</span>{" "}
                            <Badge variant={impacto.delta_em < 0 ? "success" : "warning"}>
                              {impacto.delta_em > 0 ? "+" : ""}{impacto.delta_em} un
                            </Badge>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-muted-foreground">Calculando…</div>
                    )}
                  </CardContent>
                </Card>

                {/* Seção 5 - Ação */}
                {drillEvento.status === "pendente" && (
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">5. Decisão</CardTitle></CardHeader>
                    <CardContent className="space-y-3">
                      <div>
                        <Label className="text-xs">Justificativa (opcional)</Label>
                        <Textarea
                          rows={2}
                          value={justificativa}
                          onChange={(e) => setJustificativa(e.target.value)}
                          placeholder="Ex: pedido excepcional cliente X, não se repete"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <Button variant="default" className="bg-success hover:bg-success/90 text-success-foreground" onClick={() => setAcaoConfirm({ tipo: "aceitar", lote: false })}>
                          <CheckCircle2 className="h-4 w-4 mr-1" /> Aceitar
                        </Button>
                        <Button variant="destructive" onClick={() => setAcaoConfirm({ tipo: "excluir", lote: false })}>
                          <XCircle className="h-4 w-4 mr-1" /> Excluir
                        </Button>
                        <Button variant="secondary" onClick={() => setAcaoConfirm({ tipo: "ignorar", lote: false })}>
                          <EyeOff className="h-4 w-4 mr-1" /> Ignorar
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <strong>Aceitar:</strong> evento real, mantém no cálculo. <strong>Excluir:</strong> one-off, remove da estatística. <strong>Ignorar:</strong> não mexe no dado.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {drillEvento.status !== "pendente" && (
                  <Card>
                    <CardContent className="pt-4 text-sm space-y-1">
                      <div>Status: {statusBadge(drillEvento.status)}</div>
                      <div className="text-muted-foreground">Por: {drillEvento.decidido_por ?? "—"} em {drillEvento.decidido_em ? new Date(drillEvento.decidido_em).toLocaleString("pt-BR") : "—"}</div>
                      {drillEvento.justificativa_decisao && (
                        <div className="p-2 bg-muted/50 rounded text-xs">{drillEvento.justificativa_decisao}</div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Confirmação */}
      <Dialog open={!!acaoConfirm} onOpenChange={(o) => !o && setAcaoConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Confirmar {acaoConfirm?.tipo === "aceitar" ? "aceitação" : acaoConfirm?.tipo === "excluir" ? "exclusão" : "ignorar"}
            </DialogTitle>
            <DialogDescription>
              {acaoConfirm?.lote
                ? `Aplicar a ${selecionados.size} alerta(s). Críticos não estão incluídos.`
                : `Aplicar ao alerta selecionado.`}
              {acaoConfirm?.tipo === "excluir" && (
                <div className="mt-2 text-warning">⚠ Esta ação remove os eventos do cálculo estatístico e dispara recálculo automático dos parâmetros.</div>
              )}
            </DialogDescription>
          </DialogHeader>
          {acaoConfirm?.lote && (
            <div>
              <Label className="text-xs">Justificativa em lote (opcional)</Label>
              <Textarea rows={2} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAcaoConfirm(null)}>Cancelar</Button>
            <Button
              variant={acaoConfirm?.tipo === "excluir" ? "destructive" : "default"}
              onClick={executarAcao}
              disabled={resolverMut.isPending}
            >
              {resolverMut.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
