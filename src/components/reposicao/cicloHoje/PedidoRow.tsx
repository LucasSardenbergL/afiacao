// Linha de pedido do ciclo (estado local de quantidade + aprovação/rejeição inline).
// Extraída verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Pencil, X, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { formatBRL, logAudit } from "@/lib/reposicao";
import { calcApprovalSuggestion } from "@/lib/reposicao/approvalSuggestion";
import type { ColKey, PedidoItem } from "@/types/reposicao";
import { aprovarEDisparar } from "../pedidos/aprovar-disparar";
import { EMPRESA } from "../pedidos/shared";
import { PrecoCell, ConfiancaBadge } from "./PedidoRowCells";

export function PedidoRow({
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
      if (kind === "approve") {
        // O edit on-the-spot da quantidade (num_skus) vai ANTES — a trilha canônica
        // (RPC aprovar_pedido_sugerido) não toca num_skus, então gravamos aqui primeiro.
        if (qty !== Number(row.num_skus ?? 0)) {
          const { error: qtyErr } = await supabase
            .from("pedido_compra_sugerido")
            .update({ num_skus: qty })
            .eq("id", row.id);
          if (qtyErr) throw qtyErr;
        }
        // Trilha canônica: APROVAR = DISPARAR NA HORA (não mais só UPDATE + esperar o cron).
        const r = await aprovarEDisparar({
          pedidoId: row.id,
          empresa: EMPRESA, // cockpit da Reposição é OBEN-scoped
          usuario: who,
        });
        await logAudit({
          userId: user?.id ?? null,
          action: "Aprovação inline",
          result: r.ok ? "Sucesso" : `Erro: ${r.mensagem}`,
          metadata: { id: row.id, qty },
        });
        if (!r.ok || r.tipo === "error") toast.error(r.mensagem);
        else if (r.tipo === "warning") toast.warning(r.mensagem);
        else if (r.tipo === "info") toast.info(r.mensagem);
        else toast.success(r.mensagem);
        onChanged();
        return;
      }

      // Rejeição: UPDATE direto (não passa pela trilha de disparo).
      const { error } = await supabase
        .from("pedido_compra_sugerido")
        .update({
          cancelado_em: nowIso,
          cancelado_por: who,
          status: "cancelado" as const,
          justificativa_cancelamento: "Rejeitado inline no Cockpit",
        })
        .eq("id", row.id);
      if (error) throw error;
      await logAudit({
        userId: user?.id ?? null,
        action: "Rejeição inline",
        result: "Sucesso",
        metadata: { id: row.id, qty },
      });
      toast.success("Pedido rejeitado");
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
