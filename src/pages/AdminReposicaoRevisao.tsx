import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { VariantProps } from "class-variance-authority";
import { badgeVariants } from "@/components/ui/badge";

type SkuSugeridoView = Database["public"]["Views"]["v_sku_parametros_sugeridos"]["Row"];
type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
import { useAuth } from "@/contexts/AuthContext";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SkuDetailSheet } from "@/components/reposicao/SkuDetailSheet";
import {
  type SkuParam,
  type RowWithPrice,
  type StatusFilterValue,
  fonteBadgeVariant,
  fonteBadgeLabel,
  classBadge,
  fmt,
  fmtBRL,
} from "@/lib/reposicao/sku-param";
import {
  ChevronLeft,
  ChevronRight,
  History,
  Search,
  CheckCircle2,
  Loader2,
} from "lucide-react";
const PAGE_SIZE = 25;

const CLASSE_OPTIONS = ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"];

// Tipos + helpers moved pra @/lib/reposicao/sku-param

export default function AdminReposicaoRevisao() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { empresa } = useReposicaoEmpresa();
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
          .from("v_sku_parametros_sugeridos")
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

        const priced: RowWithPrice[] = ((vdata ?? []) as SkuSugeridoView[]).map((v) => ({
          id: `view-${v.sku_codigo_omie}`,
          empresa: v.empresa ?? empresa,
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
          .from("v_sku_parametros_sugeridos")
          .select("sku_codigo_omie, preco_compra_real, preco_venda_medio, fonte_preco, fornecedor_habilitado, status_sugestao")
          .eq("empresa", empresa)
          .in("sku_codigo_omie", codes);

        type SkuPriceRow = Pick<
          SkuSugeridoView,
          "sku_codigo_omie" | "preco_compra_real" | "preco_venda_medio" | "fonte_preco" | "fornecedor_habilitado" | "status_sugestao"
        >;
        const map = new Map<number, SkuPriceRow>();
        ((vrows ?? []) as SkuPriceRow[]).forEach((row) => map.set(Number(row.sku_codigo_omie), row));
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
            <div className="overflow-x-auto -mx-6 px-6">
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
                    <TableCell className="font-mono text-xs align-top">{r.sku_codigo_omie}</TableCell>
                    <TableCell className="min-w-[280px] align-top">
                      <div className="whitespace-normal break-words leading-snug">{r.sku_descricao}</div>
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
                      <Badge variant={classBadge(r.classe_consolidada) as BadgeVariant}>
                        {r.classe_consolidada}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{fmt(r.demanda_media_diaria)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(r.preco_compra_real)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(r.preco_venda_medio)}</TableCell>
                    <TableCell>
                      <Badge variant={fonteBadgeVariant(r.fonte_preco) as BadgeVariant}>
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
            </div>
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
                      <TableCell className="font-mono text-xs align-top">{r.sku_codigo_omie}</TableCell>
                      <TableCell className="text-xs min-w-[260px] whitespace-normal break-words leading-snug align-top">
                        {r.sku_descricao}
                      </TableCell>
                      <TableCell className="align-top">{r.classe_consolidada}</TableCell>
                      <TableCell className="text-right align-top">{fmt(r.estoque_maximo, 0)}</TableCell>
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
