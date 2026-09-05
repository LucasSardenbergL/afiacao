// Linha de pedido do ciclo (estado local de quantidade + aprovação/rejeição inline).
// Extraída verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
//
// M-03: o editor de quantidade edita o ITEM (`pedido_compra_item.qtde_final`, o que o disparo compra),
// nunca `num_skus` (CONTAGEM de SKUs). Cardinalidade pelos itens (prop `itens`, carregados pelo painel
// numa query só), aprovação FAIL-CLOSED enquanto os itens não chegam, checagem do status do cabeçalho e
// compare-and-set na gravação (Codex xhigh, 5 P1).
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
import { quantidadeCompraInteira } from "@/lib/reposicao/compras-otimizador-helpers";
import { quantidadeCompraCanonica } from "@/lib/reposicao/qtde-portal";
import type { ColKey, PedidoItem } from "@/types/reposicao";
import { aprovarEDisparar } from "../pedidos/aprovar-disparar";
import { montarUpdateItem } from "../pedidos/preco-edit";
import { podeCancelarPeloHumano, rejeitarPedidos } from "../pedidos/rejeitar-pedido";
import { EMPRESA } from "../pedidos/shared";
import { PrecoCell, ConfiancaBadge } from "./PedidoRowCells";
import type { ItemDoPedido } from "./types";
import { mensagemDeErro } from '@/lib/erro-mensagem';

/** Status do cabeçalho em que a aprovação inline ainda pode gravar o item (mesma régua do modal). */
const STATUS_APROVAVEIS: ReadonlySet<string> = new Set(["pendente_aprovacao", "bloqueado_guardrail"]);

type Cardinalidade = "carregando" | "erro" | "vazio" | "unico" | "varios";

function cardinalidadeDe(itens: ItemDoPedido[] | null | undefined): Cardinalidade {
  if (itens === undefined) return "carregando";
  if (itens === null) return "erro";
  if (itens.length === 0) return "vazio";
  return itens.length === 1 ? "unico" : "varios";
}

export function PedidoRow({
  row,
  reviewMode,
  selected,
  onToggle,
  cols,
  user,
  onChanged,
  itens,
}: {
  row: PedidoItem;
  reviewMode: boolean;
  selected: boolean;
  onToggle: () => void;
  cols: Record<ColKey, boolean>;
  user: { id?: string; email?: string | null } | null;
  onChanged: () => void;
  /** Itens do pedido (do painel): `undefined` = carregando · `null` = falhou · `[]` = sem itens. */
  itens?: ItemDoPedido[] | null;
}) {
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [editingAuto, setEditingAuto] = useState(false);
  const suggestion = calcApprovalSuggestion(row);
  const showInlineEditor = suggestion.mode === "review" || editingAuto;

  const isApproved = !!row.aprovado_em;
  const isRejected = !!row.cancelado_em;
  const terminal = isApproved || isRejected;

  // Cardinalidade pelos ITENS, nunca por `num_skus` (a coluna que o bug antigo corrompia).
  const cardinalidade = cardinalidadeDe(itens);
  const item = cardinalidade === "unico" ? (itens as ItemDoPedido[])[0] : null;
  // Quantidade ORIGINAL do item (inteira, como o disparo grava) — null enquanto não há item.
  const qtdOriginal = item ? quantidadeCompraInteira(Number(item.qtde_final ?? item.qtde_sugerida ?? 0)) : null;
  const [qtd, setQtd] = useState<number | null>(null);
  useEffect(() => {
    setQtd(qtdOriginal);
  }, [qtdOriginal]);
  // Fail-closed: sem os itens carregados (ou pedido sem item) o operador não vê o que vai comprar → não aprova.
  const itensDesconhecidos = !terminal && cardinalidade !== "unico" && cardinalidade !== "varios";

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
        if (itensDesconhecidos) {
          toast.error("Itens do pedido não carregados — recarregue antes de aprovar.");
          return;
        }
        // A edição inline (pedido de 1 SKU) vai ANTES do disparo e grava o ITEM (qtde_final/valor_linha)
        // + o cabeçalho (valor_total) — nunca `num_skus`. O disparo lê `qtde_final` do item.
        if (item && qtd !== null && qtd !== qtdOriginal) {
          if (!(qtd > 0)) {
            toast.error("Quantidade inválida — informe um valor maior que zero.");
            return;
          }
          // 1. O cabeçalho ainda aceita aprovação? Outra aba pode ter aprovado/disparado este pedido.
          const { data: cab, error: cabErr } = await supabase
            .from("pedido_compra_sugerido")
            .select("status")
            .eq("id", row.id)
            .maybeSingle();
          if (cabErr) throw cabErr;
          if (!cab || !STATUS_APROVAVEIS.has(cab.status ?? "")) {
            toast.error(`Pedido não está mais aprovável (status ${cab?.status ?? "desconhecido"}) — recarregue.`);
            onChanged();
            return;
          }
          // 2. Compare-and-set: só grava se o item ainda tem a quantidade que o operador VIU.
          const update = montarUpdateItem(item, qtd, undefined);
          const base = supabase.from("pedido_compra_item").update(update).eq("id", item.id);
          const cas = item.qtde_final === null ? base.is("qtde_final", null) : base.eq("qtde_final", item.qtde_final);
          const { data: gravados, error: itemErr } = await cas.select("id");
          if (itemErr) throw itemErr;
          if (!gravados || gravados.length === 0) {
            toast.error("A quantidade do item mudou desde que você abriu a tela — recarregue e confira.");
            onChanged();
            return;
          }
          // valor_linha null = custo desconhecido → não fabricar valor_total (ausente ≠ zero)
          if (update.valor_linha !== null) {
            const { error: cabUpErr } = await supabase
              .from("pedido_compra_sugerido")
              .update({ valor_total: update.valor_linha, atualizado_em: nowIso })
              .eq("id", row.id);
            if (cabUpErr) throw cabUpErr;
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

  // Rótulo do que NÃO é editável inline: vários SKUs (ajuste no detalhe) ou estado desconhecido.
  const rotuloSemEditor = () => {
    if (terminal) return `${row.num_skus ?? 0} SKUs`;
    if (cardinalidade === "varios") {
      return (
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title="Pedido com vários SKUs — ajuste as quantidades no detalhe do pedido"
        >
          {(itens as ItemDoPedido[]).length} SKUs
        </span>
      );
    }
    return (
      <span className="text-xs text-muted-foreground" title="Itens do pedido não carregados — recarregue">
        {cardinalidade === "carregando" ? "…" : cardinalidade === "vazio" ? "sem itens" : "itens?"}
      </span>
    );
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
                  {cardinalidade === "unico" && !terminal ? (qtd ?? "—") : rotuloSemEditor()}
                </span>
                {cardinalidade === "unico" && !terminal && (
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
                {cardinalidade === "unico" && !terminal ? (
                  <Input
                    type="number"
                    min={1}
                    value={qtd ?? ""}
                    disabled={busy !== null}
                    // [QTDE-INTEIRA] o campo mostra o que vai ser gravado: inteiro (ceil) a cada tecla…
                    onChange={(e) => setQtd(quantidadeCompraInteira(Number(e.target.value)))}
                    // …e, no blur, o múltiplo da embalagem (37 L → 40 L com fator 0,2), como o modal (#2198);
                    // `montarUpdateItem` repete a regra na gravação (fronteira).
                    onBlur={() => setQtd((q) => (q === null ? q : quantidadeCompraCanonica(q, item?.fator_embalagem_portal)))}
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-8 w-20 text-right"
                    aria-label="Quantidade do item"
                  />
                ) : (
                  rotuloSemEditor()
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-status-success hover:text-status-success hover:bg-status-success-bg"
                  disabled={isApproved || busy !== null || itensDesconhecidos}
                  onClick={() => act("approve")}
                  title={itensDesconhecidos ? "Itens do pedido não carregados — recarregue" : "Aprovar"}
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
