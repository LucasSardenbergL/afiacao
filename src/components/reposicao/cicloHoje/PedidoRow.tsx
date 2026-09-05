// Linha de pedido do ciclo (estado local de quantidade + aprovação/rejeição inline).
// Extraída verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { montarUpdateItem } from "../pedidos/preco-edit";
import { podeCancelarPeloHumano, rejeitarPedidos } from "../pedidos/rejeitar-pedido";
import { quantidadeCompraInteira } from "@/lib/reposicao/compras-otimizador-helpers";
import { PrecoCell, ConfiancaBadge } from "./PedidoRowCells";
import { mensagemDeErro } from '@/lib/erro-mensagem';

/** O único item de um pedido de 1 SKU — o que o editor inline edita de verdade. */
interface ItemUnico {
  id: number;
  qtde_final: number | null;
  qtde_sugerida: number | null;
  preco_unitario: number | null;
}

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
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [editingAuto, setEditingAuto] = useState(false);
  const suggestion = calcApprovalSuggestion(row);
  const showInlineEditor = suggestion.mode === "review" || editingAuto;

  const isApproved = !!row.aprovado_em;
  const isRejected = !!row.cancelado_em;

  // Editor inline SÓ para pedido de 1 SKU. `num_skus` é CONTAGEM de SKUs, não quantidade: o editor
  // antigo inicializava com ele e gravava `num_skus` — e o disparo lê `pedido_compra_item.qtde_final`,
  // então a compra saía com a quantidade ORIGINAL (maior que a aprovada) e o cabeçalho mentia (M-03).
  // Multi-SKU: ajuste por item no detalhe do pedido.
  const itemUnico = row.num_skus === 1;
  const { data: item } = useQuery({
    queryKey: ["pedido-item-unico", row.id],
    enabled: itemUnico && cols.qtdAprovada && !isApproved && !isRejected,
    staleTime: 30_000,
    queryFn: async (): Promise<ItemUnico> => {
      const { data, error } = await supabase
        .from("pedido_compra_item")
        .select("id, qtde_final, qtde_sugerida, preco_unitario")
        .eq("pedido_id", row.id);
      if (error) throw error;
      const [it] = (data ?? []) as ItemUnico[];
      if (!it) throw new Error("pedido sem item"); // ausente ≠ zero: sem item, sem editor
      return it;
    },
  });
  // Quantidade ORIGINAL do item (inteira, como o disparo grava) — null enquanto não carregou/falhou.
  const qtdOriginal = item ? quantidadeCompraInteira(Number(item.qtde_final ?? item.qtde_sugerida ?? 0)) : null;
  const [qtd, setQtd] = useState<number | null>(null);
  useEffect(() => {
    setQtd(qtdOriginal);
  }, [qtdOriginal]);

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
        // A edição inline (pedido de 1 SKU) vai ANTES do disparo e grava o ITEM (qtde_final/valor_linha)
        // + o cabeçalho (valor_total) — nunca `num_skus`. O disparo lê `qtde_final` do item.
        if (itemUnico && item && qtd !== null && qtd !== qtdOriginal) {
          if (!(qtd > 0)) {
            toast.error("Quantidade inválida — informe um valor maior que zero.");
            return;
          }
          const update = montarUpdateItem(item, qtd, undefined);
          const { error: itemErr } = await supabase.from("pedido_compra_item").update(update).eq("id", item.id);
          if (itemErr) throw itemErr;
          // valor_linha null = custo desconhecido → não fabricar valor_total (ausente ≠ zero)
          if (update.valor_linha !== null) {
            const { error: cabErr } = await supabase
              .from("pedido_compra_sugerido")
              .update({ valor_total: update.valor_linha, atualizado_em: new Date().toISOString() })
              .eq("id", row.id);
            if (cabErr) throw cabErr;
          }
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
          metadata: { id: row.id, qtd },
        });
        if (!r.ok || r.tipo === "error") toast.error(r.mensagem);
        else if (r.tipo === "warning") toast.warning(r.mensagem);
        else if (r.tipo === "info") toast.info(r.mensagem);
        else toast.success(r.mensagem);
        onChanged();
        return;
      }

      // Rejeição: RPC com guard de status (nunca UPDATE cru — cancelava pedido já disparado, M-02).
      const r = await rejeitarPedidos([row], { usuario: who, justificativa: "Rejeitado inline no Cockpit", via: "individual" });
      const motivo = r.falhas[0]?.motivo ?? r.pulados[0]?.motivo ?? null;
      await logAudit({
        userId: user?.id ?? null,
        action: "Rejeição inline",
        result: motivo ? `Erro: ${motivo}` : "Sucesso",
        metadata: { id: row.id, qtd },
      });
      if (motivo) toast.error(`Não rejeitado: ${motivo}`);
      else toast.success("Pedido rejeitado");
      onChanged();
    } catch (err) {
      const msg = mensagemDeErro(err) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.';
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
                <span className="w-10 text-right tabular-nums font-medium">
                  {itemUnico ? (qtd ?? "—") : `${row.num_skus ?? 0} SKUs`}
                </span>
                {itemUnico && (
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8"
                    onClick={() => setEditingAuto(true)}
                    title="Editar quantidade antes de aprovar"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
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
                {itemUnico ? (
                  <Input
                    type="number"
                    min={1}
                    value={qtd ?? ""}
                    disabled={isApproved || isRejected || busy !== null || item == null}
                    onChange={(e) => setQtd(Number(e.target.value) || 0)}
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-8 w-20 text-right"
                    aria-label="Quantidade do item"
                  />
                ) : (
                  <span
                    className="text-xs text-muted-foreground tabular-nums"
                    title="Pedido com vários SKUs — ajuste as quantidades no detalhe do pedido"
                  >
                    {row.num_skus ?? 0} SKUs
                  </span>
                )}
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
                  disabled={isRejected || busy !== null || !podeCancelarPeloHumano(row.status)}
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
