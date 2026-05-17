import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Info,
  ListChecks,
  Loader2,
  Pencil,
  Search,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { formatBRL, logAudit } from "@/lib/reposicao";
import { calcApprovalSuggestion } from "@/lib/reposicao/approvalSuggestion";
import type { ColKey, PedidoItem } from "@/types/reposicao";
import { ColumnConfigPopover } from "./ColumnConfig";
import { TabFallback } from "./TabFallback";

const AdminReposicaoPedidos = lazy(() => import("@/pages/AdminReposicaoPedidos"));

export const ALL = "__all__";

type ConfLevel = "alta" | "media" | "baixa";

function inferConfianca(r: PedidoItem): { level: ConfLevel; reason: string } {
  const s = (r.status ?? "").toLowerCase();
  if (s.includes("pendente_aprovacao")) {
    return { level: "alta", reason: "Pedido pendente gerado pelos guardrails do ciclo." };
  }
  if (s.includes("disparado") || s.includes("aprovado")) {
    return { level: "alta", reason: "Pedido já aprovado/disparado." };
  }
  if (s.includes("cancel")) {
    return { level: "baixa", reason: "Pedido cancelado — comprar geraria sobrestoque." };
  }
  if (s.includes("bloque")) {
    return { level: "baixa", reason: "Bloqueado por guardrail." };
  }
  return {
    level: "media",
    reason: "Sem dados de cobertura no registro; confiança média por padrão (status pendente).",
  };
}

function PrecoCell({ row }: { row: PedidoItem }) {
  const atual = Number(row.valor_total ?? 0);
  const anterior = Number(row.pedido_anterior_valor ?? NaN);
  if (!Number.isFinite(anterior) || anterior === 0) {
    return <span className="font-medium">{formatBRL(atual)}</span>;
  }
  const deltaPct = ((atual - anterior) / anterior) * 100;
  const tone =
    Math.abs(deltaPct) < 0.5
      ? "text-muted-foreground"
      : deltaPct < 0
        ? "text-status-success"
        : "text-destructive";
  return (
    <div className="flex flex-col items-end">
      <span className="font-medium">{formatBRL(atual)}</span>
      <span className={`text-[11px] ${tone}`}>
        {deltaPct > 0 ? "+" : ""}
        {deltaPct.toFixed(1)}%
      </span>
    </div>
  );
}

function ConfiancaBadge({ row }: { row: PedidoItem }) {
  const { level, reason } = inferConfianca(row);
  const map = {
    alta: { label: "Alta", cls: "bg-status-success-bg text-status-success border-status-success/40" },
    media: { label: "Média", cls: "bg-status-warning-bg text-status-warning border-status-warning/40" },
    baixa: { label: "Baixa", cls: "bg-muted text-muted-foreground border-border" },
  } as const;
  const m = map[level];
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
          >
            <Info className="h-3 w-3" /> {m.label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[240px] text-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PedidoRow({
  row,
  reviewMode,
  selected,
  onToggle,
  cols,
  user,
  onChanged,
}: {
  row: PedidoItem;
  reviewMode: boolean;
  selected: boolean;
  onToggle: () => void;
  cols: Record<ColKey, boolean>;
  user: { id?: string; email?: string | null } | null;
  onChanged: () => void;
}) {
  const [qty, setQty] = useState<number>(Number(row.num_skus ?? 0));
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [editingAuto, setEditingAuto] = useState(false);
  const suggestion = calcApprovalSuggestion(row);
  const showInlineEditor = suggestion.mode === "review" || editingAuto;

  useEffect(() => {
    setQty(Number(row.num_skus ?? 0));
  }, [row.num_skus]);

  const isApproved = !!row.aprovado_em;
  const isRejected = !!row.cancelado_em;

  const rowBg = isApproved
    ? "bg-status-success-bg/40 hover:bg-status-success-bg"
    : isRejected
      ? "bg-destructive/5 hover:bg-destructive/10"
      : "";

  const act = async (kind: "approve" | "reject") => {
    if (busy) return;
    setBusy(kind);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";
    try {
      const patch =
        kind === "approve"
          ? {
              aprovado_em: nowIso,
              aprovado_por: who,
              status: "aprovado_aguardando_disparo" as const,
              num_skus: qty,
            }
          : {
              cancelado_em: nowIso,
              cancelado_por: who,
              status: "cancelado" as const,
              justificativa_cancelamento: "Rejeitado inline no Cockpit",
            };
      const { error } = await supabase
        .from("pedido_compra_sugerido")
        .update(patch)
        .eq("id", row.id);
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação inline" : "Rejeição inline",
        result: "Sucesso",
        metadata: { id: row.id, qty },
      });
      toast.success(kind === "approve" ? "Pedido aprovado" : "Pedido rejeitado");
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação inline" : "Rejeição inline",
        result: `Erro: ${msg}`,
        metadata: { id: row.id },
      });
      toast.error("Falha na operação");
    } finally {
      setBusy(null);
    }
  };

  return (
    <TableRow data-state={selected ? "selected" : undefined} className={rowBg}>
      {reviewMode && (
        <TableCell>
          <Checkbox checked={selected} onCheckedChange={onToggle} />
        </TableCell>
      )}
      {cols.fornecedor && (
        <TableCell className="text-sm">{row.fornecedor_nome ?? "—"}</TableCell>
      )}
      {cols.grupo && (
        <TableCell className="text-xs text-muted-foreground">
          {row.grupo_codigo ?? "—"}
        </TableCell>
      )}
      {cols.skus && <TableCell className="text-right">{row.num_skus ?? 0}</TableCell>}
      {cols.valor && (
        <TableCell className="text-right font-medium">{formatBRL(row.valor_total)}</TableCell>
      )}
      {cols.preco && (
        <TableCell className="text-right">
          <PrecoCell row={row} />
        </TableCell>
      )}
      {cols.confianca && (
        <TableCell>
          <ConfiancaBadge row={row} />
        </TableCell>
      )}
      {cols.status && (
        <TableCell>
          <Badge variant="secondary">{row.status ?? "—"}</Badge>
        </TableCell>
      )}
      {cols.qtdAprovada && (
        <TableCell>
          <div className="flex items-center gap-1.5 justify-end">
            {suggestion.mode === "auto" && !showInlineEditor ? (
              <>
                <Badge
                  variant="secondary"
                  className="gap-1 bg-primary/10 text-primary border-primary/20"
                >
                  <Zap className="h-3 w-3" /> Auto
                </Badge>
                <span className="w-10 text-right tabular-nums font-medium">{qty}</span>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  onClick={() => setEditingAuto(true)}
                  title="Editar quantidade antes de aprovar"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <>
                {suggestion.mode === "review" && (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className="gap-1 border-status-warning/40 text-status-warning bg-status-warning-bg"
                        >
                          <AlertTriangle className="h-3 w-3" /> Revisar
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[260px] text-xs">
                        {suggestion.reasons.join(" · ")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <Input
                  type="number"
                  min={0}
                  value={qty}
                  disabled={isApproved || isRejected || busy !== null}
                  onChange={(e) => setQty(Number(e.target.value) || 0)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-8 w-20 text-right"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-status-success hover:text-status-success hover:bg-status-success-bg"
                  disabled={isApproved || busy !== null}
                  onClick={() => act("approve")}
                  title="Aprovar"
                >
                  {busy === "approve" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-destructive hover:bg-destructive/10"
                  disabled={isRejected || busy !== null}
                  onClick={() => act("reject")}
                  title="Rejeitar"
                >
                  {busy === "reject" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                </Button>
              </>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

export function CicloHojePanel({
  user,
  reviewMode,
  setReviewMode,
  filters,
  setFilters,
  filteredItems,
  fornecedores,
  statuses,
  isLoading,
  cols,
  onColChange,
}: {
  user: { id?: string; email?: string | null } | null;
  reviewMode: boolean;
  setReviewMode: (b: boolean) => void;
  filters: { search: string; fornecedor: string; status: string };
  setFilters: (f: { search: string; fornecedor: string; status: string }) => void;
  filteredItems: PedidoItem[];
  fornecedores: string[];
  statuses: string[];
  isLoading: boolean;
  cols: Record<ColKey, boolean>;
  onColChange: (k: ColKey, v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);

  useEffect(() => {
    if (!reviewMode) setSelected(new Set());
  }, [reviewMode]);

  const allChecked = filteredItems.length > 0 && filteredItems.every((i) => selected.has(i.id));
  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(filteredItems.map((i) => i.id)));
  };
  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const totalSelectedValue = filteredItems
    .filter((i) => selected.has(i.id))
    .reduce((s, r) => s + Number(r.valor_total ?? 0), 0);

  const eligibleAutoItems = useMemo(
    () =>
      filteredItems.filter(
        (item) =>
          calcApprovalSuggestion(item).mode === "auto" && !item.aprovado_em && !item.cancelado_em,
      ),
    [filteredItems],
  );

  const autoApprovalGroups = useMemo(() => {
    const map = new Map<string, number>();
    eligibleAutoItems.forEach((item) => {
      const fornecedor = item.fornecedor_nome ?? "Sem fornecedor";
      map.set(fornecedor, (map.get(fornecedor) ?? 0) + Number(item.num_skus ?? 0));
    });
    return Array.from(map.entries()).map(([fornecedor, qtd]) => ({ fornecedor, qtd }));
  }, [eligibleAutoItems]);

  const manualReviewItems = useMemo(
    () =>
      filteredItems
        .filter((item) => !item.aprovado_em && !item.cancelado_em)
        .map((item) => ({ item, suggestion: calcApprovalSuggestion(item) }))
        .filter(({ suggestion }) => suggestion.mode === "review"),
    [filteredItems],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["cockpit-itens-dia"] });
    queryClient.invalidateQueries({ queryKey: ["cockpit-current-step"] });
    queryClient.invalidateQueries({ queryKey: ["reposicao-pedidos"] });
  };

  const runBatch = async (kind: "approve" | "reject") => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    const ids = Array.from(selected);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";
    try {
      const patch =
        kind === "approve"
          ? {
              aprovado_em: nowIso,
              aprovado_por: who,
              status: "aprovado_aguardando_disparo" as const,
            }
          : {
              cancelado_em: nowIso,
              cancelado_por: who,
              status: "cancelado" as const,
              justificativa_cancelamento: "Rejeitado em lote no Cockpit",
            };
      const { error } = await supabase
        .from("pedido_compra_sugerido")
        .update(patch)
        .in("id", ids);
      if (error) throw error;

      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação em lote" : "Rejeição em lote",
        result: "Sucesso",
        metadata: { ids, count: ids.length },
      });
      toast.success(
        `${ids.length} pedido(s) ${kind === "approve" ? "aprovado(s)" : "rejeitado(s)"}`,
      );
      setSelected(new Set());
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: kind === "approve" ? "Aprovação em lote" : "Rejeição em lote",
        result: `Erro: ${msg}`,
        metadata: { ids },
      });
      toast.error("Falha na operação em lote");
    } finally {
      setBusy(false);
    }
  };

  const runAutoApprove = async () => {
    if (eligibleAutoItems.length === 0 || busy) return;
    setBusy(true);
    const ids = eligibleAutoItems.map((item) => item.id);
    const nowIso = new Date().toISOString();
    const who = user?.email ?? user?.id ?? "cockpit";
    try {
      const { error } = await supabase
        .from("pedido_compra_sugerido")
        .update({
          aprovado_em: nowIso,
          aprovado_por: who,
          status: "aprovado_aguardando_disparo",
        })
        .in("id", ids);
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: "Aprovação automática — critérios atingidos",
        result: "Sucesso",
        metadata: { ids, count: ids.length },
      });
      toast.success(`${ids.length} pedido(s) aprovado(s) automaticamente`);
      setConfirmAuto(false);
      invalidate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: user?.id ?? null,
        action: "Aprovação automática — critérios atingidos",
        result: `Erro: ${msg}`,
        metadata: { ids },
      });
      toast.error("Falha ao aprovar elegíveis");
    } finally {
      setBusy(false);
    }
  };

  const clearFilters = () => setFilters({ search: "", fornecedor: ALL, status: ALL });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 bg-card">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            placeholder="Buscar SKU, descrição ou fornecedor..."
            className="pl-8 h-9"
          />
        </div>
        <Select
          value={filters.fornecedor}
          onValueChange={(v) => setFilters({ ...filters, fornecedor: v })}
        >
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="Fornecedor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
            {fornecedores.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => setFilters({ ...filters, status: v })}>
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos os status</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={clearFilters}>
          Limpar filtros
        </Button>
        <Button
          size="sm"
          onClick={() => setConfirmAuto(true)}
          disabled={eligibleAutoItems.length === 0 || busy}
          title={
            eligibleAutoItems.length === 0
              ? "Nenhum item elegível para aprovação automática"
              : "Aprovar automaticamente apenas os itens classificados como Auto"
          }
        >
          <Zap className="h-4 w-4 mr-1.5" />
          Aprovar elegíveis ({eligibleAutoItems.length})
        </Button>
        <Button
          size="sm"
          variant={reviewMode ? "default" : "outline"}
          onClick={() => setReviewMode(!reviewMode)}
        >
          <ListChecks className="h-4 w-4 mr-1.5" />
          Modo revisão
        </Button>
        <ColumnConfigPopover cols={cols} onChange={onColChange} />
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">Pedidos do ciclo ({filteredItems.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <TabFallback />
          ) : filteredItems.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Nenhum pedido para os filtros atuais.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {reviewMode && (
                    <TableHead className="w-[40px]">
                      <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
                    </TableHead>
                  )}
                  {cols.fornecedor && <TableHead>Fornecedor</TableHead>}
                  {cols.grupo && <TableHead>Grupo</TableHead>}
                  {cols.skus && <TableHead className="text-right">SKUs</TableHead>}
                  {cols.valor && <TableHead className="text-right">Valor</TableHead>}
                  {cols.preco && <TableHead className="text-right">Preço</TableHead>}
                  {cols.confianca && <TableHead>Confiança</TableHead>}
                  {cols.status && <TableHead>Status</TableHead>}
                  {cols.qtdAprovada && <TableHead className="text-right">Qtd Aprovada</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((r) => (
                  <PedidoRow
                    key={r.id}
                    row={r}
                    reviewMode={reviewMode}
                    selected={selected.has(r.id)}
                    onToggle={() => toggleOne(r.id)}
                    cols={cols}
                    user={user}
                    onChanged={invalidate}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmAuto} onOpenChange={setConfirmAuto}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" /> Aprovar elegíveis automaticamente
            </DialogTitle>
            <DialogDescription>
              {eligibleAutoItems.length} pedido(s) serão aprovados automaticamente.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-56 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead className="text-right">Qtd</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {autoApprovalGroups.map((group) => (
                  <TableRow key={group.fornecedor}>
                    <TableCell>{group.fornecedor}</TableCell>
                    <TableCell className="text-right tabular-nums">{group.qtd}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {manualReviewItems.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-status-warning" />
                {manualReviewItems.length} pedido(s) ficarão para aprovação manual
              </div>
              <div className="max-h-40 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fornecedor</TableHead>
                      <TableHead>Motivo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {manualReviewItems.map(({ item, suggestion }) => (
                      <TableRow key={item.id}>
                        <TableCell className="text-xs">
                          {item.fornecedor_nome ?? "Sem fornecedor"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {suggestion.reasons.join("; ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmAuto(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={runAutoApprove} disabled={busy || eligibleAutoItems.length === 0}>
              {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Confirmar aprovação automática
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Suspense fallback={<TabFallback />}>
        <AdminReposicaoPedidos />
      </Suspense>

      {reviewMode && selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg">
          <div className="container max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-semibold">{selected.size}</span> itens selecionados |{" "}
              <span className="font-semibold">Total: {formatBRL(totalSelectedValue)}</span>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => runBatch("reject")}
                disabled={busy}
              >
                <XCircle className="h-4 w-4 mr-1.5" /> Rejeitar selecionados
              </Button>
              <Button size="sm" onClick={() => runBatch("approve")} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-1.5" />
                )}
                Aprovar selecionados
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

