import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  ChevronLeft,
  ChevronRight,
  History,
  Search,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  Legend,
  ReferenceLine,
} from "recharts";

const PAGE_SIZE = 25;

const CLASSE_OPTIONS = ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"];

type SkuParam = {
  id: string;
  empresa: string;
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  classe_consolidada: string | null;
  classe_abc: string | null;
  classe_xyz: string | null;
  demanda_media_diaria: number | null;
  demanda_desvio_padrao: number | null;
  demanda_coef_variacao: number | null;
  demanda_dias_com_movimento: number | null;
  demanda_total_90d: number | null;
  valor_vendido_90d: number | null;
  lt_medio_dias_uteis: number | null;
  lt_desvio_padrao_dias: number | null;
  lt_p95_dias: number | null;
  lt_n_observacoes: number | null;
  fonte_leadtime: string | null;
  estoque_minimo: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  estoque_seguranca: number | null;
  z_score: number | null;
  cobertura_alvo_dias: number | null;
  aplicar_no_omie: boolean | null;
  aprovado_em: string | null;
  aprovado_por: string | null;
  justificativa_aprovacao: string | null;
  ultima_atualizacao_calculo: string | null;
};

type ViewStats = {
  pico_maximo_dia: number | null;
  p95_diario: number | null;
  p90_quando_vende: number | null;
  dias_seguranca: number | null;
  cobertura_alvo_dias: number | null;
  preco_compra_real: number | null;
  preco_venda_medio: number | null;
  preco_item_eoq: number | null;
  fonte_preco: string | null;
  n_compras: number | null;
  custo_capital_efetivo_perc: number | null;
  custo_pedido_aplicado: number | null;
  modo_pedido: string | null;
  z_aplicado: number | null;
  demanda_sigma_diario: number | null;
  sigma_lt_d: number | null;
  lead_time_medio: number | null;
  qtde_compra_ciclo_sugerida: number | null;
};

type RowWithPrice = SkuParam & {
  preco_compra_real: number | null;
  preco_venda_medio: number | null;
  fonte_preco: string | null;
  status_sugestao?: string | null;
  fornecedor_habilitado?: boolean | null;
  read_only?: boolean;
};

type StatusFilterValue = "pendente" | "aprovado" | "aguardando_fornecedor" | "todos";

const fonteBadgeVariant = (fonte: string | null | undefined): "success" | "warning" | "danger" | "outline" => {
  if (!fonte) return "danger";
  const f = fonte.toLowerCase();
  if (f.includes("compra") && f.includes("real")) return "success";
  if (f.includes("estim")) return "warning";
  if (f.includes("sem")) return "danger";
  return "outline";
};

const fonteBadgeLabel = (fonte: string | null | undefined) => {
  if (!fonte) return "Sem preço";
  const f = fonte.toLowerCase();
  if (f.includes("compra") && f.includes("real")) return "Compra real";
  if (f.includes("estim")) return "Estimado";
  if (f.includes("sem")) return "Sem preço";
  return fonte;
};

const classBadge = (classe: string | null) => {
  if (!classe) return "secondary";
  const c = classe[0];
  if (c === "A") return "destructive";
  if (c === "B") return "default";
  return "secondary";
};

const fmt = (v: number | null | undefined, dec = 2) =>
  v == null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

const fmtBRL = (v: number | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function AdminReposicaoRevisao() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [empresa] = useState("OBEN");
  const [classes, setClasses] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("pendente");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [openSku, setOpenSku] = useState<RowWithPrice | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchJustificativa, setBatchJustificativa] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["sku_parametros_revisao", empresa, classes, statusFilter, search, page],
    queryFn: async () => {
      // Caso especial: SKUs aguardando habilitação de fornecedor vêm da view
      if (statusFilter === "aguardando_fornecedor") {
        let q = supabase
          .from("v_sku_parametros_sugeridos" as any)
          .select("*", { count: "exact" })
          .eq("empresa", empresa)
          .eq("status_sugestao", "AGUARDANDO_HABILITACAO_FORNECEDOR");

        if (classes.length > 0) q = q.in("classe_consolidada", classes);
        if (search.trim()) {
          const s = search.trim();
          if (/^\d+$/.test(s)) {
            q = q.eq("sku_codigo_omie", Number(s));
          } else {
            q = q.ilike("sku_descricao", `%${s}%`);
          }
        }

        q = q.order("valor_total_90d", { ascending: false, nullsFirst: false });
        q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        const { data: vdata, error, count } = await q;
        if (error) throw error;

        const priced: RowWithPrice[] = ((vdata ?? []) as any[]).map((v) => ({
          id: `view-${v.sku_codigo_omie}`,
          empresa: v.empresa,
          sku_codigo_omie: Number(v.sku_codigo_omie),
          sku_descricao: v.sku_descricao,
          fornecedor_nome: v.fornecedor_nome,
          classe_consolidada: v.classe_consolidada,
          classe_abc: v.classe_abc_proposta,
          classe_xyz: v.classe_xyz_proposta,
          demanda_media_diaria: v.demanda_media_diaria,
          demanda_desvio_padrao: v.demanda_sigma_diario,
          demanda_coef_variacao: v.coef_variacao_ordem,
          demanda_dias_com_movimento: v.dias_com_movimento,
          demanda_total_90d: null,
          valor_vendido_90d: v.valor_total_90d,
          lt_medio_dias_uteis: v.lead_time_medio,
          lt_desvio_padrao_dias: v.lead_time_desvio,
          lt_p95_dias: v.lt_p95_dias,
          lt_n_observacoes: null,
          fonte_leadtime: v.fonte_leadtime,
          estoque_minimo: v.estoque_minimo_sugerido,
          ponto_pedido: v.ponto_pedido_sugerido,
          estoque_maximo: v.estoque_maximo_sugerido,
          estoque_seguranca: null,
          z_score: v.z_aplicado,
          cobertura_alvo_dias: v.cobertura_alvo_dias,
          aplicar_no_omie: false,
          aprovado_em: null,
          aprovado_por: null,
          justificativa_aprovacao: null,
          ultima_atualizacao_calculo: v.calculado_em,
          preco_compra_real: v.preco_compra_real,
          preco_venda_medio: v.preco_venda_medio,
          fonte_preco: v.fonte_preco,
          status_sugestao: v.status_sugestao,
          fornecedor_habilitado: v.fornecedor_habilitado,
          read_only: true,
        }));

        return { rows: priced, total: count ?? 0 };
      }

      let q = supabase
        .from("sku_parametros")
        .select("*", { count: "exact" })
        .eq("empresa", empresa)
        .eq("ativo", true)
        .not("estoque_minimo", "is", null);

      if (classes.length > 0) q = q.in("classe_consolidada", classes);
      if (statusFilter === "pendente") q = q.is("aprovado_em", null);
      if (statusFilter === "aprovado") q = q.not("aprovado_em", "is", null);
      if (search.trim()) {
        const s = search.trim();
        if (/^\d+$/.test(s)) {
          q = q.eq("sku_codigo_omie", Number(s));
        } else {
          q = q.ilike("sku_descricao", `%${s}%`);
        }
      }

      q = q.order("valor_vendido_90d", { ascending: false, nullsFirst: false });
      q = q.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      const { data, error, count } = await q;
      if (error) throw error;

      const baseRows = (data ?? []) as SkuParam[];

      // Buscar preços/fonte da view para todos os SKUs da página em uma chamada
      let priced: RowWithPrice[] = baseRows.map((r) => ({
        ...r,
        preco_compra_real: null,
        preco_venda_medio: null,
        fonte_preco: null,
      }));

      if (baseRows.length > 0) {
        const codes = baseRows.map((r) => r.sku_codigo_omie);
        const { data: vrows } = await supabase
          .from("v_sku_parametros_sugeridos" as any)
          .select("sku_codigo_omie, preco_compra_real, preco_venda_medio, fonte_preco, fornecedor_habilitado, status_sugestao")
          .eq("empresa", empresa)
          .in("sku_codigo_omie", codes);

        const map = new Map<number, any>();
        (vrows ?? []).forEach((row: any) => map.set(Number(row.sku_codigo_omie), row));
        priced = baseRows.map((r) => {
          const v = map.get(Number(r.sku_codigo_omie));
          return {
            ...r,
            preco_compra_real: v?.preco_compra_real ?? null,
            preco_venda_medio: v?.preco_venda_medio ?? null,
            fonte_preco: v?.fonte_preco ?? null,
            status_sugestao: v?.status_sugestao ?? null,
            fornecedor_habilitado: v?.fornecedor_habilitado ?? null,
            read_only: false,
          };
        });
      }

      return { rows: priced, total: count ?? 0 };
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);
  const selectedRows = useMemo(() => rows.filter((r) => selected[r.id]), [rows, selected]);

  const aggregateImpact = useMemo(() => {
    const cap = selectedRows.reduce((acc, r) => acc + (r.estoque_maximo ?? 0) * 1, 0);
    return { count: selectedRows.length, capUnits: cap };
  }, [selectedRows]);

  const approveMutation = useMutation({
    mutationFn: async (payload: { ids: string[]; justificativa?: string }) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update({
          aplicar_no_omie: true,
          aprovado_em: new Date().toISOString(),
          aprovado_por: user?.email ?? "desconhecido",
          justificativa_aprovacao: payload.justificativa || null,
        })
        .in("id", payload.ids);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(`${vars.ids.length} SKU(s) aprovado(s)`);
      setSelected({});
      setConfirmBatch(false);
      setBatchJustificativa("");
      setOpenSku(null);
      queryClient.invalidateQueries({ queryKey: ["sku_parametros_revisao"] });
    },
    onError: (e: Error) => toast.error("Falha ao aprovar: " + e.message),
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: string; values: Partial<SkuParam> }) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update(payload.values)
        .eq("id", payload.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Valores atualizados");
      queryClient.invalidateQueries({ queryKey: ["sku_parametros_revisao"] });
    },
    onError: (e: Error) => toast.error("Falha ao atualizar: " + e.message),
  });

  const toggleClasse = (c: string) => {
    setPage(0);
    setClasses((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const selectableRows = useMemo(() => rows.filter((r) => !r.read_only), [rows]);
  const allChecked = selectableRows.length > 0 && selectableRows.every((r) => selected[r.id]);
  const toggleAll = () => {
    if (allChecked) {
      const next = { ...selected };
      selectableRows.forEach((r) => delete next[r.id]);
      setSelected(next);
    } else {
      const next = { ...selected };
      selectableRows.forEach((r) => (next[r.id] = true));
      setSelected(next);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Revisão de Parâmetros de Reposição</h1>
          <p className="text-sm text-muted-foreground">
            Aprove os parâmetros sugeridos por SKU antes da aplicação no Omie.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/reposicao/historico">
            <History className="mr-2 h-4 w-4" /> Histórico
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filtros</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label className="text-xs">Empresa</Label>
              <Select value={empresa} disabled>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OBEN">OBEN</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v: StatusFilterValue) => {
                  setPage(0);
                  setStatusFilter(v);
                  setSelected({});
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pendente">Pendentes</SelectItem>
                  <SelectItem value="aprovado">Aprovados</SelectItem>
                  <SelectItem value="aguardando_fornecedor">
                    Aguardando habilitação de fornecedor
                  </SelectItem>
                  <SelectItem value="todos">Todos</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs">Busca (código ou descrição)</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  value={search}
                  placeholder="Ex: 12345 ou TINTA BASE"
                  onChange={(e) => {
                    setPage(0);
                    setSearch(e.target.value);
                  }}
                />
              </div>
            </div>
          </div>

          <div>
            <Label className="text-xs">Classe consolidada</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {CLASSE_OPTIONS.map((c) => (
                <Badge
                  key={c}
                  variant={classes.includes(c) ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => toggleClasse(c)}
                >
                  {c}
                </Badge>
              ))}
              {classes.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setClasses([])}>
                  Limpar
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            {total} SKU(s) encontrados — página {page + 1} de {totalPages}
          </CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={selectedIds.length === 0}
              onClick={() => setConfirmBatch(true)}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Aprovar selecionados ({selectedIds.length})
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
                  </TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Classe</TableHead>
                  <TableHead className="text-right">D/dia</TableHead>
                  <TableHead className="text-right">R$ compra</TableHead>
                  <TableHead className="text-right">R$ venda</TableHead>
                  <TableHead>Fonte</TableHead>
                  <TableHead className="text-right">LT (du)</TableHead>
                  <TableHead className="text-right">EM</TableHead>
                  <TableHead className="text-right">PP</TableHead>
                  <TableHead className="text-right">Emax</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className={r.read_only ? "bg-muted/30" : undefined}>
                    <TableCell>
                      {r.read_only ? (
                        <span className="inline-block h-4 w-4" aria-hidden />
                      ) : (
                        <Checkbox
                          checked={!!selected[r.id]}
                          onCheckedChange={(v) =>
                            setSelected((s) => ({ ...s, [r.id]: !!v }))
                          }
                        />
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.sku_codigo_omie}</TableCell>
                    <TableCell className="max-w-xs">
                      <div className="truncate">{r.sku_descricao}</div>
                      {r.read_only && r.fornecedor_nome && (
                        <Badge
                          variant="warning"
                          className="mt-1 text-[10px] font-medium"
                          title="Fornecedor pendente de habilitação para reposição"
                        >
                          🏭 {r.fornecedor_nome}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={classBadge(r.classe_consolidada) as any}>
                        {r.classe_consolidada}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{fmt(r.demanda_media_diaria)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(r.preco_compra_real)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(r.preco_venda_medio)}</TableCell>
                    <TableCell>
                      <Badge variant={fonteBadgeVariant(r.fonte_preco) as any}>
                        {fonteBadgeLabel(r.fonte_preco)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{fmt(r.lt_medio_dias_uteis, 1)}</TableCell>
                    <TableCell className="text-right">{fmt(r.estoque_minimo, 0)}</TableCell>
                    <TableCell className="text-right">{fmt(r.ponto_pedido, 0)}</TableCell>
                    <TableCell className="text-right">{fmt(r.estoque_maximo, 0)}</TableCell>
                    <TableCell>
                      {r.read_only ? (
                        <Badge
                          variant="secondary"
                          className="bg-muted text-muted-foreground border-muted-foreground/20"
                          title="SKU bloqueado: fornecedor ainda não habilitado para reposição automática"
                        >
                          Aguardando fornecedor
                        </Badge>
                      ) : r.aprovado_em ? (
                        <Badge variant="default">Aprovado</Badge>
                      ) : (
                        <Badge variant="outline">Pendente</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => setOpenSku(r)}>
                        Detalhes
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={14} className="text-center text-muted-foreground py-8">
                      Nenhum SKU encontrado para os filtros atuais.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-end gap-2 pt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              {page + 1}/{totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <SkuDetailSheet
        sku={openSku}
        onClose={() => setOpenSku(null)}
        onApprove={(justificativa) =>
          openSku && approveMutation.mutate({ ids: [openSku.id], justificativa })
        }
        onSaveValues={(values) =>
          openSku && updateMutation.mutate({ id: openSku.id, values })
        }
        isApproving={approveMutation.isPending}
        isSaving={updateMutation.isPending}
      />

      <Dialog open={confirmBatch} onOpenChange={setConfirmBatch}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Aprovar {aggregateImpact.count} SKU(s)</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="rounded-md border p-3">
                <div className="text-muted-foreground">Total de SKUs</div>
                <div className="text-2xl font-semibold">{aggregateImpact.count}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-muted-foreground">Estoque máx. agregado (un)</div>
                <div className="text-2xl font-semibold">
                  {fmt(aggregateImpact.capUnits, 0)}
                </div>
              </div>
            </div>

            <div className="max-h-48 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>Classe</TableHead>
                    <TableHead className="text-right">Emax</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.sku_codigo_omie}</TableCell>
                      <TableCell className="text-xs max-w-[260px] truncate">
                        {r.sku_descricao}
                      </TableCell>
                      <TableCell>{r.classe_consolidada}</TableCell>
                      <TableCell className="text-right">{fmt(r.estoque_maximo, 0)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div>
              <Label>Justificativa (opcional, aplicada a todos)</Label>
              <Textarea
                value={batchJustificativa}
                onChange={(e) => setBatchJustificativa(e.target.value)}
                placeholder="Ex: Revisão trimestral aprovada pela operação."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmBatch(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() =>
                approveMutation.mutate({ ids: selectedIds, justificativa: batchJustificativa })
              }
              disabled={approveMutation.isPending}
            >
              {approveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar aprovação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down (Sheet lateral)
// ─────────────────────────────────────────────────────────────────────────────
function SkuDetailSheet({
  sku,
  onClose,
  onApprove,
  onSaveValues,
  isApproving,
  isSaving,
}: {
  sku: RowWithPrice | null;
  onClose: () => void;
  onApprove: (justificativa?: string) => void;
  onSaveValues: (values: Partial<SkuParam>) => void;
  isApproving: boolean;
  isSaving: boolean;
}) {
  const [justificativa, setJustificativa] = useState("");
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<{ em: string; pp: string; emax: string }>({
    em: "",
    pp: "",
    emax: "",
  });

  const open = !!sku;

  // Stats from view (pico, p95, preços, custos, fórmula)
  const { data: stats } = useQuery<ViewStats | null>({
    queryKey: ["sku_view_stats", sku?.empresa, sku?.sku_codigo_omie],
    enabled: open,
    queryFn: async () => {
      if (!sku) return null;
      const { data, error } = await supabase
        .from("v_sku_parametros_sugeridos" as any)
        .select(
          "pico_maximo_dia, p95_diario, p90_quando_vende, cobertura_alvo_dias, " +
            "preco_compra_real, preco_venda_medio, preco_item_eoq, fonte_preco, n_compras, " +
            "custo_capital_efetivo_perc, custo_pedido_aplicado, modo_pedido, " +
            "z_aplicado, demanda_sigma_diario, sigma_lt_d, lead_time_medio, qtde_compra_ciclo_sugerida"
        )
        .eq("empresa", sku.empresa)
        .eq("sku_codigo_omie", sku.sku_codigo_omie)
        .maybeSingle();
      if (error) return null;
      return data as any;
    },
  });

  // 90d daily demand chart
  const { data: demanda } = useQuery({
    queryKey: ["sku_demanda_90d", sku?.empresa, sku?.sku_codigo_omie],
    enabled: open,
    queryFn: async () => {
      if (!sku) return [];
      const since = new Date();
      since.setDate(since.getDate() - 90);
      const { data, error } = await supabase
        .from("venda_items_history")
        .select("data_emissao, quantidade")
        .eq("empresa", sku.empresa)
        .eq("sku_codigo_omie", sku.sku_codigo_omie)
        .gte("data_emissao", since.toISOString())
        .order("data_emissao", { ascending: true });
      if (error) return [];
      const buckets: Record<string, number> = {};
      for (let i = 0; i < 90; i++) {
        const d = new Date();
        d.setDate(d.getDate() - (89 - i));
        const k = d.toISOString().slice(0, 10);
        buckets[k] = 0;
      }
      (data ?? []).forEach((row: any) => {
        const k = String(row.data_emissao).slice(0, 10);
        if (k in buckets) buckets[k] += Number(row.quantidade ?? 0);
      });
      return Object.entries(buckets).map(([dia, qtde]) => ({
        dia: dia.slice(5),
        qtde: Math.round(qtde * 100) / 100,
      }));
    },
  });

  if (!sku) return null;

  const Z = stats?.z_aplicado ?? sku.z_score ?? null;
  const D = sku.demanda_media_diaria ?? null;
  const LT = stats?.lead_time_medio ?? sku.lt_medio_dias_uteis ?? null;
  const sigmaD = stats?.demanda_sigma_diario ?? sku.demanda_desvio_padrao ?? null;
  const sigmaLT = sku.lt_desvio_padrao_dias ?? null;
  const Cp = stats?.custo_pedido_aplicado ?? null;
  const Cm = stats?.custo_capital_efetivo_perc ?? null;
  const preco = stats?.preco_item_eoq ?? stats?.preco_compra_real ?? null;
  const QC = stats?.qtde_compra_ciclo_sugerida ?? null;
  const markup =
    stats?.preco_compra_real && stats?.preco_venda_medio
      ? stats.preco_venda_medio / stats.preco_compra_real
      : null;

  const justificativaAuto =
    `SKU classe ${sku.classe_consolidada}. Fórmula Silver-Pyke-Peterson com service level Z = ${fmt(Z, 2)}:\n` +
    `• Safety Stock = Z × √(LT × σ_D² + D² × σ_LT²) = ${fmt(Z, 2)} × √(${fmt(LT, 1)}×${fmt(sigmaD, 2)}² + ${fmt(D, 2)}²×${fmt(sigmaLT, 2)}²) = ${fmt(sku.estoque_minimo, 0)}\n` +
    `• Ponto de Pedido = D×LT + SS = ${fmt(D, 2)}×${fmt(LT, 1)} + ${fmt(sku.estoque_minimo, 0)} = ${fmt(sku.ponto_pedido, 0)}\n` +
    `• Lote de Compra (EOQ) = √(2 × D_anual × Cp / (Cm × preço)) = √(2×${fmt(D, 2)}×252×${fmt(Cp, 2)} / (${fmt(Cm, 4)}×${fmtBRL(preco)})) = ${fmt(QC, 0)}\n` +
    `• Estoque Máximo = PP + QC = ${fmt(sku.ponto_pedido, 0)} + ${fmt(QC, 0)} = ${fmt(sku.estoque_maximo, 0)}\n` +
    `Cobertura efetiva: ${stats?.cobertura_alvo_dias ?? sku.cobertura_alvo_dias ?? "—"} dias de demanda.`;

  const startEdit = () => {
    setEdit({
      em: String(sku.estoque_minimo ?? ""),
      pp: String(sku.ponto_pedido ?? ""),
      emax: String(sku.estoque_maximo ?? ""),
    });
    setEditing(true);
  };
  const saveEdit = () => {
    onSaveValues({
      estoque_minimo: Number(edit.em),
      ponto_pedido: Number(edit.pp),
      estoque_maximo: Number(edit.emax),
    });
    setEditing(false);
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-start justify-between gap-2">
            <span>
              {sku.sku_descricao}
              <span className="ml-2 text-xs font-mono text-muted-foreground">
                #{sku.sku_codigo_omie}
              </span>
            </span>
            <Badge variant={classBadge(sku.classe_consolidada) as any}>
              {sku.classe_consolidada}
            </Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-5 py-4 text-sm">
          {/* Identificação */}
          <section>
            <h3 className="font-semibold mb-2">Identificação</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Fornecedor</dt>
              <dd>{sku.fornecedor_nome ?? "—"}</dd>
              <dt className="text-muted-foreground">Empresa</dt>
              <dd>{sku.empresa}</dd>
              <dt className="text-muted-foreground">Última atualização</dt>
              <dd>
                {sku.ultima_atualizacao_calculo
                  ? new Date(sku.ultima_atualizacao_calculo).toLocaleString("pt-BR")
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Valor vendido 90d</dt>
              <dd>{fmtBRL(sku.valor_vendido_90d)}</dd>
            </dl>
          </section>

          {/* Demanda */}
          <section>
            <h3 className="font-semibold mb-2">Estatísticas de demanda (180d)</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Demanda média/dia</dt>
              <dd>{fmt(sku.demanda_media_diaria)}</dd>
              <dt className="text-muted-foreground">Desvio padrão</dt>
              <dd>{fmt(sku.demanda_desvio_padrao)}</dd>
              <dt className="text-muted-foreground">Coef. variação</dt>
              <dd>{fmt(sku.demanda_coef_variacao)}</dd>
              <dt className="text-muted-foreground">Dias com movimento</dt>
              <dd>{sku.demanda_dias_com_movimento ?? "—"}</dd>
              <dt className="text-muted-foreground">Pico máximo (dia)</dt>
              <dd>{fmt(stats?.pico_maximo_dia, 0)}</dd>
              <dt className="text-muted-foreground">P95 diário</dt>
              <dd>{fmt(stats?.p95_diario)}</dd>
            </dl>
          </section>

          {/* Preço e custo */}
          <section>
            <h3 className="font-semibold mb-2">Preço e custo</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Preço de compra médio</dt>
              <dd className="flex items-center gap-2">
                {fmtBRL(stats?.preco_compra_real)}
                <span className="text-xs text-muted-foreground">
                  (baseado em {stats?.n_compras ?? 0} compras)
                </span>
              </dd>
              <dt className="text-muted-foreground">Preço de venda médio (180d)</dt>
              <dd>{fmtBRL(stats?.preco_venda_medio)}</dd>
              <dt className="text-muted-foreground">Markup implícito</dt>
              <dd>
                {markup
                  ? `${fmt(markup, 2)}x (${fmt((markup - 1) * 100, 1)}%)`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Custo de capital efetivo</dt>
              <dd>
                {stats?.custo_capital_efetivo_perc != null
                  ? `${fmt(stats.custo_capital_efetivo_perc * 100, 2)}% a.a.`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Custo de pedido aplicado</dt>
              <dd>{fmtBRL(stats?.custo_pedido_aplicado)}</dd>
              <dt className="text-muted-foreground">Modo atual</dt>
              <dd>
                <Badge variant={stats?.modo_pedido === "api" ? "info" as any : "outline"}>
                  {stats?.modo_pedido === "api" ? "API" : stats?.modo_pedido === "manual" ? "Manual" : "—"}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">Fonte do preço</dt>
              <dd>
                <Badge variant={fonteBadgeVariant(stats?.fonte_preco) as any}>
                  {fonteBadgeLabel(stats?.fonte_preco)}
                </Badge>
              </dd>
            </dl>
          </section>

          {/* Lead time */}
          <section>
            <h3 className="font-semibold mb-2">Lead time</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">LT médio (du)</dt>
              <dd>{fmt(sku.lt_medio_dias_uteis, 1)}</dd>
              <dt className="text-muted-foreground">Desvio padrão</dt>
              <dd>{fmt(sku.lt_desvio_padrao_dias, 1)}</dd>
              <dt className="text-muted-foreground">P95 LT</dt>
              <dd>{fmt(sku.lt_p95_dias, 1)}</dd>
              <dt className="text-muted-foreground">Observações</dt>
              <dd>{sku.lt_n_observacoes ?? "—"}</dd>
              <dt className="text-muted-foreground">Fonte</dt>
              <dd>{sku.fonte_leadtime ?? "—"}</dd>
            </dl>
          </section>

          {/* Sugeridos */}
          <section className="rounded-md border bg-accent/30 p-3">
            <h3 className="font-semibold mb-2">Parâmetros sugeridos</h3>
            {!editing ? (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">Estoque mínimo</div>
                  <div className="text-2xl font-semibold">{fmt(sku.estoque_minimo, 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Ponto pedido</div>
                  <div className="text-2xl font-semibold">{fmt(sku.ponto_pedido, 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Estoque máximo</div>
                  <div className="text-2xl font-semibold">{fmt(sku.estoque_maximo, 0)}</div>
                </div>
                <div className="col-span-3 text-xs text-muted-foreground">
                  Cobertura alvo: {sku.cobertura_alvo_dias ?? stats?.cobertura_alvo_dias ?? "—"} dias
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">EM</Label>
                  <Input
                    type="number"
                    value={edit.em}
                    onChange={(e) => setEdit((s) => ({ ...s, em: e.target.value }))}
                  />
                </div>
                <div>
                  <Label className="text-xs">PP</Label>
                  <Input
                    type="number"
                    value={edit.pp}
                    onChange={(e) => setEdit((s) => ({ ...s, pp: e.target.value }))}
                  />
                </div>
                <div>
                  <Label className="text-xs">Emax</Label>
                  <Input
                    type="number"
                    value={edit.emax}
                    onChange={(e) => setEdit((s) => ({ ...s, emax: e.target.value }))}
                  />
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-3">
              {!editing ? (
                <Button size="sm" variant="outline" onClick={startEdit}>
                  Editar valores manualmente
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={saveEdit} disabled={isSaving}>
                    {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Salvar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancelar
                  </Button>
                </>
              )}
            </div>
          </section>

          {/* Justificativa auto */}
          <section>
            <h3 className="font-semibold mb-2">Justificativa</h3>
            <p className="text-muted-foreground leading-relaxed whitespace-pre-line font-mono text-xs">{justificativaAuto}</p>
          </section>

          {/* Gráfico */}
          <section>
            <h3 className="font-semibold mb-2">Demanda diária (últimos 90d)</h3>
            <div className="h-56 w-full">
              <ResponsiveContainer>
                <ComposedChart data={demanda ?? []} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="dia" tick={{ fontSize: 10 }} interval={9} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <ReTooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="qtde" name="Demanda" fill="hsl(var(--primary))" />
                  {sku.estoque_minimo != null && (
                    <ReferenceLine
                      y={sku.estoque_minimo}
                      stroke="hsl(var(--destructive))"
                      strokeDasharray="4 4"
                      label={{ value: "EM", fontSize: 10, position: "right" }}
                    />
                  )}
                  {sku.ponto_pedido != null && (
                    <ReferenceLine
                      y={sku.ponto_pedido}
                      stroke="hsl(var(--accent-foreground))"
                      strokeDasharray="4 4"
                      label={{ value: "PP", fontSize: 10, position: "right" }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Aprovação */}
          <section className="space-y-2 border-t pt-4">
            {sku.read_only ? (
              <div className="rounded-md border border-dashed bg-muted/50 p-3 text-sm text-muted-foreground space-y-1">
                <div className="font-medium text-foreground flex items-center gap-2">
                  <Badge variant="secondary" className="bg-muted">Aguardando fornecedor</Badge>
                </div>
                <p>
                  Este SKU não pode ser aprovado enquanto o fornecedor{" "}
                  <strong>{sku.fornecedor_nome ?? "—"}</strong> não estiver habilitado para
                  reposição automática. Habilite o fornecedor antes de aprovar os parâmetros.
                </p>
                <div className="flex justify-end pt-2">
                  <Button variant="outline" onClick={onClose}>
                    Fechar
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Label>Justificativa da aprovação (opcional)</Label>
                <Textarea
                  value={justificativa}
                  onChange={(e) => setJustificativa(e.target.value)}
                  placeholder="Ex: Parâmetros condizem com a sazonalidade observada."
                />
                {sku.aprovado_em && (
                  <p className="text-xs text-muted-foreground">
                    Já aprovado em {new Date(sku.aprovado_em).toLocaleString("pt-BR")} por{" "}
                    {sku.aprovado_por}.
                  </p>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={onClose}>
                    Fechar
                  </Button>
                  <Button onClick={() => onApprove(justificativa)} disabled={isApproving}>
                    {isApproving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {sku.aprovado_em ? "Reaprovar" : "Aprovar este SKU"}
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
